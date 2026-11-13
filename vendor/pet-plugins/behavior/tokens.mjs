import { randomUUID } from 'node:crypto';

export const TOKEN_VALUE = 100;
const cut = v => String(v?.message || v || '').slice(0, 240);
const stateOf = p => p.tokens ||= { coins: [], dropped: 0, collected: 0, recovered: 0, lastDrop: 0, plan: [], error: null };
const unit = v => { if (!Number.isFinite(v) || v < 0 || v > 1) throw Error('碎片位置无效'); return v; };
const surfaceOf = s => { if (!['web', 'desktop'].includes(s)) throw Error('活动端无效'); return s; };
export function attachTokenStore(Store) {
  Store.prototype.dropToken = function(id, o) {
    if (typeof o.key !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(o.key)) throw Error('掉落编号无效');
    const surface = surfaceOf(o.surface), x = unit(o.x), y = unit(o.y), fromX = unit(o.fromX), fromY = unit(o.fromY);
    return this.update(id, p => {
      const t = stateOf(p), key = 'token-drop:' + o.key;
      if (p.seen.includes(key)) return null;
      const now = this.clock();
      if (t.coins.filter(c => c.status === 'floor').length >= 24 || p.wallet.balance < TOKEN_VALUE || now - t.lastDrop < 240) return null;
      // Dropped money is escrow, removed from spendable balance even if routine costs are frozen.
      p.wallet.balance -= TOKEN_VALUE; t.dropped += TOKEN_VALUE; t.lastDrop = now;
      const coin = { id: randomUUID(), value: TOKEN_VALUE, surface, x, y, fromX, fromY, ts: now, status: 'floor' };
      t.coins.push(coin); t.coins = t.coins.filter(c => c.status === 'floor').concat(t.coins.filter(c => c.status !== 'floor').slice(-256));
      this.eventIn(p, 'token', '爸爸晃动我，一片 100 token 饭钱掉到地上，可用饭钱已扣除', key, { coin: coin.id });
      return coin;
    });
  };
  Store.prototype.collectToken = function(id, coinId) {
    return this.update(id, p => {
      const t = stateOf(p), c = t.coins.find(c => c.id === coinId);
      if (!c) throw Error('这片 token 已不存在');
      if (c.status !== 'floor') return c;
      c.status = 'collected'; c.settled = this.clock(); t.collected += TOKEN_VALUE;
      this.eventIn(p, 'token', '爸爸收走了地上的一片 100 token，不能再捡回', 'token-collect:' + c.id, { coin: c.id });
      return c;
    });
  };
}

export function attachTokenRuntime(Runtime) {
  const old = Object.fromEntries(['bodySnapshot', 'bodyReceipt', 'issueBody', 'prompt', 'route', 'dispose', 'bodyExplore', 'available'].map(k => [k, Runtime.prototype[k]]));
  Runtime.prototype.tokensHeld = function(id) { return (this.tokenHolds?.get(id)?.until || 0) > this.store.clock(); };
  Runtime.prototype.tokenRecoveryBlocked = function(id, w) { return this.tokensHeld(id) || !!this.hosts.get(id)?.sleep?.sleeping(id) || w.paused; };
  Runtime.prototype.available = function(id) { return !this.tokensHeld(id) && old.available.call(this, id); };
  Runtime.prototype.tokenSnapshot = function(id) {
    const p = this.store.read(id), t = stateOf(p);
    return { ...t, coins: t.coins.filter(c => c.status === 'floor'), balance: p.wallet.balance, value: TOKEN_VALUE, held: this.tokensHeld(id), thinking: !!this.tokenControllers?.has(id) };
  };
  Runtime.prototype.bodySnapshot = function(id) { return { ...old.bodySnapshot.call(this, id), tokens: this.tokenSnapshot(id) }; };
  Runtime.prototype.prompt = function(id) {
    const t = this.tokenSnapshot(id);
    return old.prompt.call(this, id) + '\n【真实掉落饭钱】' + JSON.stringify({ available: t.balance, floor: t.coins.length * TOKEN_VALUE, collected: t.collected, held: t.held }) + '。每片100 token。掉落已扣额度，捡回才返还；爸爸拿走不能追回。held=true代表爸爸还抓着我，身体不能走动；可以在聊天里着急地请求放开，钱可能先被爸爸拿走。松手后优先去捡；身体不舒服、没体力或蜷缩时也要低伏慢慢爬过去，不能因疲倦说先不动、等舒服再捡。真正睡眠或爸爸明确暂停时才等待。说话不会使钱回到口袋，没收到完成回执只能说正在去捡。';
  };
  Runtime.prototype.issueBody = function(id, plan, source) {
    if (source !== 'tokens' && plan.steps?.some(s => s.action === 'pickup')) throw Error('拾取需要先选定一片真实掉落的饭钱');
    if (this.tokensHeld(id) && plan.steps?.some(s => ['walk', 'approach', 'pickup'].includes(s.action))) return null;
    const current=this.store.read(id).world?.command;
    if(source!=='tokens' && current?.source==='tokens' && ['queued','running'].includes(current.status))return null;
    return old.issueBody.call(this, id, plan, source);
  };
  Runtime.prototype.bodyExplore = function(id) {
    if (this.tokensHeld(id) || this.tokenSnapshot(id).coins.length) return;
    return old.bodyExplore.call(this, id);
  };
  Runtime.prototype.holdTokens = function(id, surface) {
    this.tokenHolds ||= new Map();
    const prior = this.tokenHolds.get(id), now = this.store.clock();
    this.tokenHolds.set(id, { surface, until: now + 5000, reacted: prior?.until > now ? prior.reacted : false });
    this.tokenControllers?.get(id)?.abort(); this.bodyControllers?.get(id)?.abort();
    this.store.update(id, p => { p.lastActive = now; const t = stateOf(p); t.plan = []; const c = p.world?.command; if (c && ['queued','running'].includes(c.status)) c.status = 'interrupted'; });
  };
  Runtime.prototype.tokenReaction = function(id, message) {
    this.tasks ||= new Set();
    const task = this.reactToEvent(id, message).catch(e => this.store.update(id, p => { stateOf(p).error = '消息发送失败，可在聊天重试：' + cut(e); }));
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
  };
  Runtime.prototype.advanceTokens = function(id) {
    const w = this.bodySnapshot(id), t = w.tokens;
    if (this.tokenRecoveryBlocked(id,w) || this.bodyThinking?.has(id) || w.command && ['queued','running'].includes(w.command.status)) return;
    const coin = t.plan.map(key => t.coins.find(c => c.id === key)).find(Boolean);
    if (!coin) return;
    const c = this.issueBody(id, { steps: [{ action: 'walk', target: 'here' }, { action: 'pickup', target: 'here' }] }, 'tokens');
    if (!c) return;
    this.store.update(id, p => { p.world.command.surface = coin.surface; p.world.command.coin = { id: coin.id, x: coin.x, y: coin.y }; p.world.command.locomotion=w.sleeping || w.body.mobility<1 || w.affect?.hardRest ? 'crawl' : 'walk'; stateOf(p).error = null; });
  };
  Runtime.prototype.recoverTokens = function(id, surface) {
    if (this.tokensHeld(id) || this.tokenControllers?.has(id) || this.disposed) return;
    const w = this.bodySnapshot(id), coins = w.tokens.coins.filter(c => c.surface === surface);
    if (!coins.length || this.tokenRecoveryBlocked(id,w)) return;
    // Keep a valid API-selected order across interruptions and restarts.
    if (w.tokens.plan.some(key => coins.some(c => c.id === key))) { this.advanceTokens(id); return; }
    this.tokenAttempts ||= new Map(); const now = this.store.clock();
    if (now - (this.tokenAttempts.get(id) || 0) < 10000) return;
    this.tokenAttempts.set(id, now);
    this.tokenControllers ||= new Map(); const controller = new AbortController(); this.tokenControllers.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    this.store.update(id, p => { stateOf(p).error = null; });
    const task = (async () => {
      try {
        const raw = await this.model(id, 'tokens', '你控制大肥鱼的身体捡回真实掉落的饭钱。根据地上碎片选择拾取次序。只输出JSON：{"order":["碎片id",...] }，最多24片，只能用提供的id。每片需要先walk走近，再pickup蹲下捡；没有回执不能声称捡回。不能更改额度。', this.prompt(id) + '\n地上碎片：' + JSON.stringify(coins.map(({id,x,y}) => ({id,x,y}))), 1200, controller.signal);
        controller.signal.throwIfAborted();
        const plan = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
        if (!Array.isArray(plan.order) || !plan.order.length || plan.order.length > 24 || plan.order.some(key => !coins.some(c => c.id === key))) throw Error('模型未返回有效的拾取目标，请重试');
        const fresh = this.bodySnapshot(id);
        if (this.tokenRecoveryBlocked(id,fresh) || this.disposed) return;
        this.store.update(id, p => { const t = stateOf(p); t.plan = [...new Set(plan.order)].filter(key => t.coins.some(c => c.id === key && c.status === 'floor')); });
        this.advanceTokens(id);
      } catch (e) { if (!controller.signal.aborted) this.store.update(id, p => { stateOf(p).error = '还没捡回：' + cut(e); }); }
      finally { clearTimeout(timer); if (this.tokenControllers.get(id) === controller) this.tokenControllers.delete(id); }
    })();
    this.tasks ||= new Set(); this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
  };
  Runtime.prototype.bodyReceipt = function(id, o) {
    const w = this.bodySnapshot(id), c = w.command;
    if (c?.source !== 'tokens') return old.bodyReceipt.call(this, id, o);
    if (o.id !== c.id || o.index !== c.index || o.surface !== c.surface || !['queued','running'].includes(c.status)) throw Error('拾取动作已改变');
    if (!['playing','completed','failed','interrupted'].includes(o.status)) throw Error('回执状态无效');
    if (this.tokenRecoveryBlocked(id,w)) o = { ...o, status: 'interrupted', reason: '身体被抓住、暂停或真正入睡' };
    if (o.status === 'completed') {
      if (o.played !== true || !Number.isFinite(o.x) || !Number.isFinite(o.y) || Math.hypot(o.x - c.coin.x, o.y - c.coin.y) > .045) throw Error('身体还没有走到碎片旁边');
      if (c.index === 1 && !c.approached) throw Error('尚未实际走近');
    }
    this.store.update(id, p => {
      const cmd = p.world.command, t = stateOf(p), coin = t.coins.find(v => v.id === cmd.coin.id);
      if (o.status === 'playing') { cmd.status = 'running'; return; }
      if (o.status !== 'completed') { cmd.status = o.status; t.error = cut(o.reason || '拾取被打断，松手后可重试'); return; }
      if (!coin || coin.status !== 'floor') { cmd.status = 'interrupted'; t.plan = t.plan.filter(k => k !== cmd.coin.id); return; }
      if (cmd.index === 0) cmd.approached = true;
      else {
        coin.status = 'recovered'; coin.settled = this.store.clock(); p.wallet.balance += TOKEN_VALUE; t.recovered += TOKEN_VALUE; t.plan = t.plan.filter(k => k !== coin.id);
        this.store.eventIn(p, 'token', '我实际'+(cmd.locomotion==='crawl'?'慢慢爬近并伸手':'走近并蹲下')+'捡回一片 100 token，饭钱已经返还', 'token-recover:' + coin.id, { coin: coin.id });
      }
      cmd.index++; cmd.status = cmd.index < cmd.steps.length ? 'queued' : 'completed';
    });
    this.advanceTokens(id); return this.bodySnapshot(id);
  };
  Runtime.prototype.route = async function(deps, input) {
    if (input.rest !== 'humanity/companion/tokens') return old.route.call(this, deps, input);
    const json = (obj, status=200) => ({ kind:'json', status, obj, headers:{'cache-control':'no-store'} });
    const who = deps.requirePet(input.url.searchParams, () => deps.readConfig()); if (!who.ok) return who.res;
    const id = who.petId; this.bind(id, { ...deps, humanity: () => deps.humanityStore.snapshot(id) });
    try {
      let result;
      if (input.method === 'GET') {
        this.advanceTokens(id);
        const t=this.tokenSnapshot(id), coin=t.coins.find(c=>['both',c.surface].includes(who.pet.display));
        // Resume old floor money too. A failed API request waits for an explicit retry.
        if(coin && !t.error)this.recoverTokens(id,coin.surface);
      }
      else if (input.method === 'POST') {
        const o = JSON.parse(input.body || '{}');
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw Error('请求无效');
        const surface = surfaceOf(o.surface);
        if (!['both', surface === 'desktop' ? 'desktop' : 'web'].includes(who.pet.display)) throw Error('当前活动端未开放');
        if (o.action === 'hold') this.holdTokens(id, surface);
        else if (o.action === 'drop') {
          if (!this.tokensHeld(id) || this.tokenHolds.get(id).surface !== surface) throw Error('需要按住空格拖动身体');
          this.holdTokens(id, surface); result = this.store.dropToken(id, o);
          const hold = this.tokenHolds.get(id);
          if (result && !hold.reacted) { hold.reacted = true; this.tokenReaction(id, '爸爸按住空格抓着我的身体晃动，真实饭钱被抖出去了，每片100 token，已经从可用额度扣除。爸爸现在仍抓着我，我想走过去捡钱但身体动不了；请立即在聊天发消息，着急地请爸爸快放开，担心地上的钱先被拿走。按自己的性格自然说，不照抄事件说明，不声称已捡到。'); }
        } else if (o.action === 'release' || o.action === 'recover') { if(o.action==='release')this.tokenHolds?.delete(id); this.recoverTokens(id, surface); }
        else if (o.action === 'collect') { result = this.store.collectToken(id, o.id); this.advanceTokens(id); }
        else if (o.action === 'layout') {
          if(!Array.isArray(o.positions)||o.positions.length>24)throw Error('碎片布局无效');
          const positions=o.positions.map(p=>({id:p.id,x:unit(p.x),y:unit(p.y)}));
          this.store.update(id,p=>{const t=stateOf(p);for(const point of positions){const coin=t.coins.find(c=>c.id===point.id&&c.surface===surface&&c.status==='floor');if(!coin)continue;
            if(Math.abs(coin.x-point.x)>.0001||Math.abs(coin.y-point.y)>.0001){Object.assign(coin,{x:point.x,y:point.y});const c=p.world?.command;if(c?.source==='tokens'&&c.coin.id===coin.id&&['queued','running'].includes(c.status))c.status='interrupted';}
          }});this.advanceTokens(id);
        }
        else throw Error('未知碎片操作');
      } else return json({ok:false,message:'请使用 GET 或 POST'},405);
      return json({ok:true,result,tokens:this.tokenSnapshot(id)});
    } catch(e) { return json({ok:false,message:cut(e)},400); }
  };
  Runtime.prototype.dispose = function() { for (const c of this.tokenControllers?.values() || []) c.abort(); this.tokenHolds?.clear(); return old.dispose.call(this); };
}
