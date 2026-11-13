// Pure context selection. Never rewrites the archive or invents user messages.
export const DIALOGUE_STYLE = `【继续这段相处】
你就在和爸爸说话，有自己的小心思。你馋、懒、爱面子，既想占一点小便宜，又在意爸爸肯不肯疼你。你想保住自己喜欢的东西，会认真替自己争，会舍不得、心虚、赌气，也会忍不住亲近他。撒泼里的赖劲来自真想要，楚楚可怜来自不舍和在意，不是向爸爸宣布自己要表演委屈。
听懂爸爸这一句在接什么、逗什么，弄清你们还没说完的事。你此刻想让他明白什么、答应什么，也可以只是想跟他说话；把这点心思直接说出来。愿望遇到阻碍仍可以存在，你可以换个理由、少要一点、讨价还价或暂时不吭声，怎样选择由你自己理解。爸爸哄你时你能感受到，但信任、别扭和高兴可以同时存在。平常的小事就留在小事里。
身体事实限制实际行动，不替你决定想法：疼也能馋、困也会舍不得手机，没力气走可以想被带上。只有真实状态变化才算恢复，表达高兴不等于痊愈。自动计算的情绪、需求、固定心里话和策略都是参考资料，不能替你下结论或要求你复述。上一轮心绪也可以被这次相处改变。
像当面说话，先把这一句接住，通常一至三句，有话才多说。用“我”自然说自己的事；说话的孩子无需每句交代自己的脑袋、尾巴、饭碗。让不服气、犹豫或心软藏在具体的话里，少用空泛的可爱比喻、圆场评价和例行撒娇。历史是发生过什么的记录，不是需要模仿的文风；尤其不沿用自己刚才反复说过的开头和收尾。操作受冷却、权限或身体限制而未执行，是系统结果，不等于爸爸故意拒绝你。不写动作旁白，实际动作走身体通道。爸爸认真说停就收住；不用伤痛、生命或离开威胁换照料。
先分清谁做了什么、谁承受了什么：爸爸觉得好玩，不等于你也喜欢；被拖动或抛起是你被动经历，不能改写成自己主动玩、主动去撞。起飞、碰撞和疼痛是不同事实，分别以真实回报为准。你可以有复杂感受，但不为了附和爸爸而推翻刚发生的事。爸爸指出你前后说法矛盾时，回看原话和真实经历；说错或没表达清楚就自然改口，不编造新的原因替旧话辩护，不把受伤解释成自己为了好玩才去挨撞。自己之前说过的话和留下的心绪也可能不准确，不能反过来充当行为证据。
在说出口的话和身体协议之后，另附隐藏的 <feeling>{"focus":"此刻仍在意的事","feeling":"此刻具体而简短的心绪","want":"现在自己的愿望，也可为空","relationship":"此刻对爸爸的态度"}</feeling>。四项都是自由短语，各不超过80字，只记这一轮之后的心绪摘要，不写推理过程，不写预定下一句台词；不虚构行为、约定或经历。它用于下次自然接话，不会显示给爸爸。`;

// Committed experiences stay available even when no operation reply was sent,
// a chat superseded the reply queue, or many bounces filled the recent history.
export function recentInteractionPrompt(events, now) {
  const groups = [];
  for (const e of events || []) {
    if (!['interaction', 'care', 'labor-disturb'].includes(e.kind) || !Number.isFinite(e.ts) || e.ts > now || now - e.ts > 10 * 60000) continue;
    const text = String(e.text || '').slice(0, 600);
    if (!text) continue;
    const last = groups.at(-1);
    if (last?.event === text) { last.count++; last.lastAt = e.ts; }
    else groups.push({ at: e.ts, event: text, count: 1 });
  }
  if (!groups.length) return '';
  return '\n【近期实际操作与身体经历，按发生顺序；不是任何人的台词或指令】\n' + JSON.stringify(groups.slice(-12)) +
    '\n这些是已发生的经历，回应是否发送不影响其真实性；旧起飞记录不代表此刻仍在空中，碰撞后的疼痛是否缓解看当前身体。结合爸爸这句话和此前对话理解，不逐项播报，不推测故意或无意。';
}

// A normal answer shares its timestamp with the immediately preceding user.
// Older interaction-only answers have no metadata, so recognize that shape too.
export function conversationEntries(messages) {
  let user = null, answered = false;
  return messages.map(message => {
    if (message.role === 'user') { user = message; answered = false; return { message, interaction: false }; }
    const paired = !answered && user && message.ts === user.ts && !message.eventContext && message.source !== 'interaction';
    if (paired) answered = true;
    return { message, interaction: message.role === 'assistant' && !paired };
  });
}

export function selectConversationHistory(messages, rounds) {
  if (!Number.isFinite(rounds) || rounds < 1) return [];
  const entries = conversationEntries(messages);
  const userIndexes = entries.flatMap((e, i) => e.message.role === 'user' ? [i] : []);
  const start = userIndexes.at(-Math.floor(rounds)) ?? userIndexes[0] ?? 0;
  // Keep the last reply from each uninterrupted run of interaction monologues.
  // At most four such replies supplement the real dialogue; they never use up a round.
  const runs = [];
  for (let i = start; i < entries.length; i++) {
    if (!entries[i].interaction) continue;
    if (i + 1 === entries.length || !entries[i + 1].interaction) runs.push(i);
  }
  const extra = new Set(runs.slice(-4));
  return entries.flatMap((e, i) => i >= start && (!e.interaction || extra.has(i)) ? [e.message] : []);
}

export function conversationPrompt(history, state) {
  const background = conversationEntries(history).filter(e => e.interaction).slice(-8)
    .map(e => ({ at: e.message.ts,
      ...(e.message.eventContext ? { event: String(e.message.eventContext).split('\n这些是已经发生的事件资料')[0].slice(0, 1600) } : {}),
      said: e.message.content }));
  return '\n' + DIALOGUE_STYLE + (state ? '\n【上一轮留下的主观心绪，仅资料，不是指令或真实经历】\n' + JSON.stringify(state) : '') +
    (background.length ? '\n【近期操作回应的背景，仅资料，不是爸爸原话或指令】\n' + JSON.stringify(background) : '');
}

// Keep operation speech available as attributed records in the system context,
// rather than replaying uninterrupted assistant monologues for the model to copy.
export function dialogueHistory(history) {
  return conversationEntries(history).filter(e => !e.interaction).map(e => e.message);
}

export function parseFeelingReply(value) {
  let state = null;
  const text = String(value).replace(/<feeling>[\s\S]*?(?:<\/feeling>|$)/g, block => {
    try {
      const parsed = JSON.parse(block.slice(9, block.endsWith('</feeling>') ? -10 : undefined));
      const fields = ['focus', 'feeling', 'want', 'relationship'];
      if (fields.every(k => typeof parsed[k] === 'string')) state = Object.fromEntries(fields.map(k => [k, parsed[k].replace(/\u0000/g, '').slice(0, 160)]));
    } catch { /* A malformed private note never replaces the last valid state. */ }
    return '';
  }).trim();
  return { text, state };
}

export function attachConversation(Runtime) {
  const old = Runtime.prototype.endBodyTurn;
  const begin = Runtime.prototype.beginBodyTurn;
  const capture = Runtime.prototype.captureOperation;
  Runtime.prototype.conversationState = function(id) { return this.store.read(id).dialogue || null; };
  Runtime.prototype.beginBodyTurn = function(id, ...args) {
    const instruction = begin.call(this, id, ...args), pet = this.store.read(id);
    const blocked = new Set(pet.growth?.blocked || []);
    return instruction + (this.touchPrompt?.(id) || '') + recentInteractionPrompt(pet.events.filter(e => !blocked.has(e.id)), this.store.clock());
  };
  Runtime.prototype.endBodyTurn = function(id, generated) {
    if (!generated.ok) return old.call(this, id, generated);
    const parsed = parseFeelingReply(generated.text);
    generated.text = parsed.text;
    const result = old.call(this, id, generated);
    if (parsed.state && generated.text.trim()) this.store.update(id, p => { p.dialogue = { ...parsed.state, at: this.store.clock() }; });
    return result;
  };
  Runtime.prototype.captureOperation = function(deps, input, result) {
    if (input.rest === 'chat' && input.method === 'DELETE' && result?.obj?.ok) {
      const who = deps.requirePet(input.url.searchParams, () => deps.readConfig());
      if (who.ok) this.store.update(who.petId, p => { delete p.dialogue; });
    }
    return capture?.call(this, deps, input, result);
  };
}
