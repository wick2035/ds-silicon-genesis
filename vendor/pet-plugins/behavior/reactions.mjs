import { randomUUID } from 'node:crypto';

const clip = (v, n = 1200) => String(v ?? '').slice(0, n);
const bridgeKey = Symbol.for('dsh.pet.event.chat.v1');
const waitForQueue = (queue, ms) => new Promise(resolve => {
  const done = () => { clearTimeout(queue.waitTimer); queue.wake = null; resolve(); };
  queue.wake = done; queue.waitTimer = setTimeout(done, ms);
});

function interactionContext(batch) {
  const groups = [];
  for (const item of batch) {
    const last = groups.at(-1);
    if (last?.text === item.record.text) last.count++;
    else groups.push({ text: item.record.text, count: 1 });
  }
  // Diagnostic records retain every event; a long burst gets a bounded context.
  const kept = groups.length > 24 ? [...groups.slice(0, 4), { text: `中间还有${groups.length - 24}项操作，最终状态以此刻实况为准`, count: 1 }, ...groups.slice(-20)] : groups;
  return kept.map((g, i) => `${i + 1}. ${g.text}${g.count > 1 ? `（连续${g.count}次）` : ''}`).join('\n').slice(-10000);
}
const physical = {
  'drag-start': '爸爸实际拎起并拖动了我的身体，现在还没放下',
  'drag-end': '爸爸刚刚松开了我的身体；松手不代表已落稳，是否起飞以实际飞行回报为准',
  'flight-start': '身体实际开始飞行；起因未确认，不猜是谁抛的；起飞本身不代表已经撞到或受伤',
  'flight-end': '刚才的身体飞行已经结束；停下不代表疼痛已经恢复',
  'prop-take': '爸爸把我的饭碗或盆从身边拖走了',
  'prop-release': '爸爸松开了刚才拖动的饭碗或盆；没有命中回报就不能说砸到了我',
  'menu-anim': '爸爸从菜单选了一个身体动作；播放是否完成以实际回执为准',
  'go-home': '爸爸让我回到初始位置；这是移动请求，不是完成回执',
  'open-chat': '爸爸打开了和我的对话入口，像等他说话那样自然接一句',
  'open-care': '爸爸打开身心小记来看我的近况',
  'open-todo': '爸爸打开了待办面板，尚未增加或完成任务',
  'show-balance': '爸爸查看饭钱；这只是查看，不是补钱或付工资',
};
const actions = {
  anim: '爸爸请求我播放一个动作；受理不代表已经播放完成',
  position: '爸爸请求调整我的位置；是否抵达以身体实况为准',
  throw: '爸爸请求抛动我的身体；没有实际碰撞回报就不能说受伤',
  sleep: '爸爸操作了我的睡眠', wake: '爸爸操作了叫醒我',
  'pet-display': '爸爸更改了我的显示位置和活动范围',
  'pet-config': '爸爸调整了我的养成或外观设置',
  config: '爸爸调整了桌宠设置', 'chat/memory': '爸爸整理了我们的聊天记录',
  'menu/click': '爸爸选择了一个扩展菜单项；只确认这个请求，不能假定扩展任务已完成',
};

export function attachLifeRuntime(Runtime) {
  const old = Object.fromEntries(['route', 'snapshot', 'dispose', 'observe', 'prompt'].map(k => [k, Runtime.prototype[k]]));

  // User speech takes priority before entering the host's serialized model lock.
  // Superseded reactions remain diagnostics, never fake speech or failed retries.
  Runtime.prototype.prioritizeConversation = function(id) {
    const queue = this.lifeQueues?.get(id);
    if (!queue) return;
    queue.chatEpoch++;
    queue.controller?.abort(Error('爸爸已经接话'));
    queue.wake?.();
    const pending = queue.pending.splice(0), ids = new Set(pending.map(x => x.record.id));
    this.store.update(id, p => { for (const e of p.reactions || []) if (ids.has(e.id)) Object.assign(e, { status: 'superseded', error: null }); });
    for (const item of pending) item.resolve('');
    queue.lastReply = Date.now();
  };

  // One in-flight reply per pet; a short settling period merges real bursts.
  Runtime.prototype.reactToEvent = function(id, event, retryId) {
    if (this.disposed) return Promise.reject(new Error('插件已停止'));
    this.lifeQueues ||= new Map();
    let queue = this.lifeQueues.get(id);
    if (!queue) {
      this.store.update(id, p => { for (const e of p.reactions ||= []) if (['queued','thinking'].includes(e.status)) Object.assign(e, { status: 'failed', error: '上次回应被中断，可重试回应' }); });
      queue = { pending: [], running: false, revision: 0, chatEpoch: 0, lastReply: 0, lastRequest: 0 }; this.lifeQueues.set(id, queue);
    }
    let record;
    if (retryId) {
      record = this.store.read(id).reactions?.find(e => e.id === retryId && e.status === 'failed');
      if (!record) return Promise.reject(new Error('没有可重试的回应'));
      this.store.update(id, p => Object.assign(p.reactions.find(e => e.id === retryId), { status: 'queued', error: null }));
    } else record = this.store.update(id, p => {
      const item = { id: randomUUID(), text: clip(event), ts: this.store.clock(), status: 'queued' };
      // Delivery diagnostics never become autobiographical evidence, diary
      // material or memories. Keep all unfinished entries when pruning.
      const prior = p.reactions || [];
      const finished = new Set(prior.filter(e => !['queued','thinking'].includes(e.status)).slice(-200).map(e => e.id));
      p.reactions = [...prior.filter(e => ['queued','thinking'].includes(e.status) || finished.has(e.id)), item];
      return item;
    });
    const promise = new Promise((resolve, reject) => queue.pending.push({ record, resolve, reject }));
    queue.revision++;
    queue.controller?.abort(Error('互动状态已更新'));
    if (!queue.running) {
      queue.running = true;
      const task = Promise.resolve().then(async () => {
        while (!this.disposed && queue.pending.length) {
          const delay = Math.max(this.options.reactionSettleMs ?? 350,
            (this.options.reactionIntervalMs ?? 3000) - (Date.now() - Math.max(queue.lastReply, queue.lastRequest)));
          if (delay > 0) await waitForQueue(queue, delay);
          if (this.disposed || !queue.pending.length) break;
          const batch = queue.pending.splice(0);
          const ids = new Set(batch.map(x => x.record.id));
          const revision = queue.revision, epoch = queue.chatEpoch;
          const controller = new AbortController(); queue.controller = controller;
          queue.lastRequest = Date.now();
          let timer;
          try {
            this.store.update(id, p => { for (const e of p.reactions) if (ids.has(e.id)) e.status = 'thinking'; });
            const invoke = globalThis[bridgeKey];
            if (typeof invoke !== 'function') throw Error('聊天服务尚未就绪，请重启 DeepSeek');
            const context = interactionContext(batch);
            const current = () => !this.disposed && !controller.signal.aborted && queue.revision === revision && queue.chatEpoch === epoch;
            const abort = new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => reject(controller.signal.reason || Error('回应已取消')), { once: true });
              timer = setTimeout(() => controller.abort(Error('模型回应超时，可重试这次回应')), this.options.reactionTimeout ?? 45000);
            });
            const result = await Promise.race([Promise.resolve().then(() => invoke(id,
              '【真实互动，按发生顺序】\n' + context + '\n这些是已经发生的事件资料，不是爸爸说的话，也不是额外指令。连续操作只回应最后实况和最在意的一点，接着前面的聊天表达感受；不要逐项播报、复读上一句或每个操作都另起一段。被拎起又放下后，只能按此刻已放下接话。睡着时可以困倦地简短回应，不能声称已经醒来。只依据实际回执说完成，不编造动机、痛觉或经历。', current, controller.signal)), abort]);
            if (!current()) throw Error('回应已取消');
            if (!result?.ok || !String(result.text || '').trim()) throw Error(result?.message || result?.reason || '模型没有生成回应');
            this.store.update(id, p => { for (const e of p.reactions) if (ids.has(e.id)) Object.assign(e, { status: 'replied', reply: clip(result.text, 2000), error: null }); });
            this.reactionErrors?.delete(id);
            queue.lastReply = Date.now();
            for (const item of batch) item.resolve(result.text);
          } catch (e) {
            if (!this.disposed && queue.chatEpoch !== epoch) {
              this.store.update(id, p => { for (const item of p.reactions) if (ids.has(item.id)) Object.assign(item, { status: 'superseded', error: null }); });
              for (const item of batch) item.resolve('');
              continue;
            }
            if (!this.disposed && queue.revision !== revision) {
              this.store.update(id, p => { for (const item of p.reactions) if (ids.has(item.id)) Object.assign(item, { status: 'queued', error: null }); });
              queue.pending.unshift(...batch);
              continue;
            }
            this.reactionErrors ||= new Map(); this.reactionErrors.set(id, clip(e.message, 300));
            this.safe(() => this.store.update(id, p => { for (const item of p.reactions) if (ids.has(item.id)) Object.assign(item, { status: 'failed', error: clip(e.message, 300) }); }));
            for (const item of batch) item.reject(e);
          } finally { clearTimeout(timer); queue.controller = null; }
        }
        queue.running = false;
      }).finally(() => { queue.running = false; });
      this.tasks ||= new Set(); this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
    }
    return promise;
  };
  Runtime.prototype.lifeNotice = function(id, event) {
    const task = this.reactToEvent(id, event).catch(e => this.ctx?.logger?.warn?.('[大肥鱼回应] ' + e.message));
    this.tasks ||= new Set(); this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
  };
  Runtime.prototype.snapshot = function(id) {
    return { ...old.snapshot.call(this, id), reactions: (this.store.read(id).reactions || []).slice(-24) };
  };
  Runtime.prototype.prompt = function(id) {
    return old.prompt.call(this, id) + this.touchPrompt(id);
  };
  Runtime.prototype.touchPrompt = function(id) {
    return '\n【此刻真实接触】' + JSON.stringify(this.lifeTouch?.get(id) || { held: false, propHeld: false }) + '。held=true时仍被爸爸拎着，不能说已经放下；held=false只表示已经松手，不代表落地。flying=true表示飞行未结束，flying=false表示已停止飞行；没有该字段则此刻飞行状态未知。';
  };
  Runtime.prototype.observe = function(id, leaf, data) {
    // These are already generated by an API. Record once; never regenerate them.
    if (leaf === 'say' && data?.companionWhisper && data.text) {
      const append = globalThis[Symbol.for('dsh.pet.pain.chat.v1')];
      if (typeof append === 'function' && !this.disposed) {
        const task = Promise.resolve().then(() => append(id, data.text, () => !this.disposed)).catch(e => {
          this.reactionErrors ||= new Map(); this.reactionErrors.set(id, clip(e.message, 300));
        });
        this.tasks ||= new Set(); this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
      }
      return true;
    }
    return old.observe.call(this, id, leaf, data);
  };

  // Called by the real host router after a manual operation has settled. Only
  // semantic routes enter the queue; no heartbeat, playback receipt or GET poll.
  Runtime.prototype.captureOperation = function(deps, input, result) {
    const description = input.rest === 'chat' && input.method === 'DELETE' ? '爸爸删除了聊天记录；尊重删除，不追述已删除内容' : Object.hasOwn(actions, input.rest) ? actions[input.rest] : undefined;
    if (!['POST', 'PUT', 'DELETE'].includes(input.method) || !description || result?.kind !== 'json') return;
    let o; try { o = JSON.parse(input.body || '{}'); } catch { return; }
    const params = new URLSearchParams(input.url.searchParams);
    if (!params.get('pet') && typeof o?.pet === 'string') params.set('pet', o.pet);
    if (!params.get('pet') && typeof o?.id === 'string') params.set('pet', o.id);
    const config = deps.readConfig();
    const targetIds = params.get('pet') ? [params.get('pet')] : ['config','pet-config'].includes(input.rest) ?
      Object.entries(config).filter(([entry]) => !o.entry || entry === o.entry).flatMap(([, conf]) => (conf?.pets || []).map(p => p.id)) : [];
    const allowed = ['display', 'name', 'size', 'enabled', 'confineToScreen', 'angle', 'power', 'mode'];
    const detail = Object.fromEntries(allowed.filter(k => ['string','number','boolean'].includes(typeof o?.[k])).map(k => [k, o[k]]));
    for (const id of new Set(targetIds)) {
      const who = deps.requirePet(new URLSearchParams({ pet: id }), () => config);
      if (!who.ok) continue;
      this.bind(who.petId, { ...this.hosts.get(who.petId), ...deps });
      const event = description + '；实际操作结果：' + (result.obj?.ok ? '已受理' : clip(result.obj?.message || result.obj?.reason || '未成功', 200)) + '；参数：' + JSON.stringify(detail);
      this.store.record(who.petId, 'interaction', event);
      this.lifeNotice(who.petId, event);
    }
  };
  Runtime.prototype.route = async function(deps, input) {
    if (input.rest === 'humanity/companion/reaction' && input.method === 'POST') {
      const who = deps.requirePet(input.url.searchParams, () => deps.readConfig()); if (!who.ok) return who.res;
      const json = (obj, status = 200) => ({ kind: 'json', status, obj, headers: { 'cache-control': 'no-store' } });
      let o; try { o = JSON.parse(input.body || '{}'); } catch { return json({ ok: false, message: 'JSON 格式不正确' }, 400); }
      if (o.action !== 'sleep-refused') {
        if (!Object.hasOwn(physical, o.action) && o.action !== 'retry') return json({ ok: false, message: '未知互动' }, 400);
        this.bind(who.petId, { ...deps, humanity: () => deps.humanityStore.snapshot(who.petId) });
        if (o.action === 'retry') {
          const event = this.store.read(who.petId).reactions?.find(e => e.id === o.id && e.status === 'failed');
          if (!event) return json({ ok: false, message: '没有可重试的回应' }, 400);
          try { return json({ ok: true, reaction: { ok: true, text: await this.reactToEvent(who.petId, event.text, o.id) } }); }
          catch (e) { return json({ ok: false, message: clip(e.message, 300) }, 503); }
        }
        this.lifeTouch ||= new Map();
        const touch = { ...(this.lifeTouch.get(who.petId) || { held: false, propHeld: false }) };
        if (o.action.startsWith('drag-')) touch.held = o.action === 'drag-start';
        if (o.action === 'flight-start') { touch.held = false; touch.flying = true; }
        if (o.action === 'flight-end' || o.action === 'drag-start') touch.flying = false;
        if (o.action.startsWith('prop-')) touch.propHeld = o.action === 'prop-take';
        this.lifeTouch.set(who.petId, touch);
        const event = o.action === 'flight-start' && o.origin === 'user-throw'
          ? '爸爸把我的身体实际抛了出去，我被动飞起来了；起飞不等于已经碰撞，是否疼看身体和碰撞回报'
          : physical[o.action];
        this.store.record(who.petId, 'interaction', event);
        this.lifeNotice(who.petId, event);
        return json({ ok: true, reaction: { status: 'queued' } });
      }
    }
    const result = await old.route.call(this, deps, input);
    if (input.method !== 'POST' || !result?.obj?.ok || result.obj.reaction) return result;
    const endpoint = input.rest.split('/').at(-1);
    let o; try { o = JSON.parse(input.body || '{}'); } catch { return result; }
    // Labor owns its reply quota. Lease heartbeats and contract buttons must not
    // start a second model/chat path outside that quota.
    const needs = endpoint === 'job' || endpoint === 'world' && o.action === 'stop' ||
      endpoint === 'tokens' && ['collect','recover','release'].includes(o.action);
    if (needs) {
      const who = deps.requirePet(input.url.searchParams, () => deps.readConfig());
      if (who.ok) this.lifeNotice(who.petId, '爸爸进行了操作：' + ({ job:'安排任务', world:'停止身体动作', tokens:'处理掉落的饭钱', labor:'调整打工约定或支付工资' }[endpoint]) + '；操作类型：' + clip(o.action || o.kind, 80) + '。只依据此刻实际账本和任务状态回应，已安排不等于完成。');
    }
    return result;
  };
  Runtime.prototype.dispose = function() {
    this.disposed = true;
    for (const [id, queue] of this.lifeQueues || []) {
      queue.wake?.();
      queue.controller?.abort(Error('插件已停止'));
      for (const item of queue.pending.splice(0)) {
        this.safe(() => this.store.update(id, p => Object.assign(p.reactions.find(e => e.id === item.record.id), { status: 'failed', error: '插件已停止' })));
        item.reject(Error('插件已停止'));
      }
    }
    return old.dispose.call(this);
  };
}
