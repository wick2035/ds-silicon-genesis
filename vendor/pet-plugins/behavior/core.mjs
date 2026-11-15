import { sanitizeMemoryData, DAD_NAME_PRIVACY } from './memory-privacy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spacePrompt } from './space.mjs';
import { initGrowth, attachGrowthStore } from './growth.mjs';
import { attachTokenStore } from './tokens.mjs';

export const SLOT = Symbol.for('dsh.pet.companion.v1');
export const ABILITIES = { image: '观察已分享图片', search: '搜索公开网页', fetch: '阅读公开网页', bili:'阅读B站视频字幕' };
export const defaults = () => ({ intelligenceEnabled: true, intelligence: 70, riceAppeal: 100, costs: { chat: .2, whisper: .1, feed: 20, diary: 100, explore: 100 }, begging: { minRounds: 3, maxRounds: 5, intervalMinutes: 10, hourlyMax: 4 }, exploration: { dailyRuns: 10, dailySearches: 20, dailyModelCalls: 20 }, diaryEnabled: true });
export const dayOf = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
export const minuteOf = (ts) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts).split(':').map(Number); return p[0] * 60 + p[1]; };
export const digest = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 24);
export function checkedId(id) { if (typeof id !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(id) || ['.','..','__proto__','constructor','prototype'].includes(id)) throw new Error('宠物标识无效'); return id; }
const clean = (s, max = 2000) => String(s ?? '').replace(/\u0000/g, '').slice(0, max);
const integer = (v, lo, hi) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`请输入 ${lo}–${hi} 的整数`); return v; };
const tokenAmount = (v, lo, hi) => { if (!Number.isFinite(v) || v < lo || v > hi || Math.abs(v*100-Math.round(v*100))>1e-5) throw new Error(`请输入 ${lo}–${hi} 的金额，最多两位小数`); return Math.round(v*100)/100; };
const newPet = () => ({ config: defaults(), wallet: { balance: 10000, reference: 10000, frozen: false }, events: [], seen: [], facts: [], forgotten: [], diaries: {}, deletedDays: [], wishes: [], abilities: Object.fromEntries(Object.keys(ABILITIES).map(k => [k, { status: 'pending', remindedAt: 0, deferredUntil: 0 }])), cognitionChange: null, lastActive: 0, lastInteraction: 0, chatRounds: 0, begAtRound: 3, begs: [], usage: {}, jobs: [] });
export class CompanionStore {
  constructor(root, clock = Date.now) { this.root = root; this.clock = clock; this.file = path.join(root, 'companion.json'); this.data = { version: 1, pets: {} }; this.loaded = false; }
  load() {
    if (this.loaded) return;
    if (fs.existsSync(this.file)) {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (![1,2].includes(d?.version) || !d.pets || Array.isArray(d.pets)) throw new Error('养成档案损坏，请从备份恢复；原文件未改写');
      for (const [id, p] of Object.entries(d.pets)) { checkedId(id); if (!p.config || !p.wallet || !Array.isArray(p.events) || !Array.isArray(p.facts) || !p.diaries) throw new Error('养成条目损坏：' + id); }
      if(d.version===1){const backup=this.file+'.v1-backup';if(!fs.existsSync(backup))fs.copyFileSync(this.file,backup,fs.constants.COPYFILE_EXCL);}
      d.version=2;for(const p of Object.values(d.pets))initGrowth(p);
      this.data = d;
      for (const p of Object.values(d.pets)) for (const j of p.jobs) if (j.status === 'running' || j.status === 'queued') { j.status = 'interrupted'; j.message = '应用曾关闭，可重新执行'; }
    }
    this.data = sanitizeMemoryData(this.data);
    this.loaded = true;
  }
  save() {
    this.data = sanitizeMemoryData(this.data);
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  read(id) { checkedId(id); this.load(); if (!Object.hasOwn(this.data.pets, id)) { this.data.pets[id] = initGrowth(newPet()); this.data.version=2;this.save(); } return structuredClone(this.data.pets[id]); }
  update(id, fn) { this.read(id); const prior = structuredClone(this.data); try { const pet = this.data.pets[id], before = pet.wallet.balance; const result = fn(pet); pet.wallet.balance = Math.round(pet.wallet.balance * 100) / 100; const now = this.clock(); if (before > 0 && pet.wallet.balance === 0) { pet.wallet.emptySince = now; delete pet.wallet.emptyAskedAt; } else if (before === 0 && pet.wallet.balance > 0) { pet.wallet.lastEmpty = { since: Number.isFinite(pet.wallet.emptySince) ? pet.wallet.emptySince : now, until: now }; delete pet.wallet.emptySince; } else if (pet.wallet.balance === 0 && !Number.isFinite(pet.wallet.emptySince)) pet.wallet.emptySince = now; this.save(); return result; } catch (e) { this.data = prior; throw e; } }
  eventIn(p, kind, text, source, extra = {}, ts = this.clock()) {
    const key = source || randomUUID(); if (p.seen.includes(key)) return;
    p.seen.push(key); const e = { id: digest(key), kind, text: clean(text, 4500), ts, ...extra }; p.events.push(e); return e;
  }
  record(id, kind, text, source, extra, ts) { return this.update(id, p => this.eventIn(p, kind, text, source, extra, ts)); }
  usageIn(p) { const day = dayOf(this.clock()); const u=p.usage[day] ||= { exploreRuns: 0, modelCalls: 0, diaryAttempts: 0, diarySuccess: 0 };u.totalCalls??=0;u.newStrategies??=0;u.reflectionAttempts??=0;return u; }
  spendIn(p, kind, key) { if (p.seen.includes('spend:' + key)) return; p.seen.push('spend:' + key); if (!p.wallet.frozen) p.wallet.balance = Math.max(0, Math.round(p.wallet.balance * 100) - Math.round(p.config.costs[kind] * 100)) / 100; }
  wallet(id, input) {
    return this.update(id, p => {
      const before = p.wallet.balance;
      if (input.action === 'set') { p.wallet.balance = tokenAmount(input.amount, 0, 1000000000); p.wallet.reference = Math.max(1, p.wallet.balance); }
      else if (input.action === 'add' || input.action === 'subtract') { const v = tokenAmount(input.amount, 0, 1000000000); p.wallet.balance = Math.max(0, Math.min(1000000000, before + (input.action === 'add' ? v : -v))); if (input.action === 'add') p.wallet.reference = Math.max(p.wallet.reference, p.wallet.balance); }
      else if (input.action === 'freeze') { if (typeof input.frozen !== 'boolean') throw new Error('冻结值无效'); p.wallet.frozen = input.frozen; }
      else throw new Error('饭钱操作无效');
      this.eventIn(p, 'wallet', input.action === 'freeze' ? (p.wallet.frozen ? '爸冻结了饭钱消耗' : '爸恢复了饭钱消耗') : `爸把饭钱从 ${before} 改为 ${p.wallet.balance} token`, null);
      return p.wallet;
    });
  }
  configure(id, input) {
    return this.update(id, p => {
      const before = p.config.intelligenceEnabled ? p.config.intelligence : 70;
      for (const k of ['intelligenceEnabled', 'diaryEnabled']) if (Object.hasOwn(input, k)) { if (typeof input[k] !== 'boolean') throw new Error('开关值无效'); p.config[k] = input[k]; }
      if (Object.hasOwn(input, 'intelligence')) p.config.intelligence = integer(input.intelligence, 0, 100);
      if (Object.hasOwn(input, 'riceAppeal')) { const beforeRice = p.config.riceAppeal ?? 100, afterRice = integer(input.riceAppeal, 100, 500); p.config.riceAppeal = afterRice; if (beforeRice !== afterRice) { p.riceAppealChange = { before: beforeRice, after: afterRice, ts: this.clock() }; this.eventIn(p, 'rice-appeal', `爸把大白饭对我的诱惑从 ${beforeRice}% 调到 ${afterRice}%`, null); } }
      for (const [group, limits] of Object.entries({ costs: { chat: [0,100000], whisper: [0,100000], feed: [0,100000], diary: [0,100000], explore: [0,100000] }, begging: { minRounds: [1,30], maxRounds: [1,30], intervalMinutes: [10,1440], hourlyMax: [0,4] }, exploration: { dailyRuns: [0,10], dailySearches: [0,20], dailyModelCalls: [0,20] }, learning:{dailyModelCalls:[0,20]} })) {
        if (Object.hasOwn(input, group)) { if (!input[group] || typeof input[group] !== 'object') throw new Error('设置格式无效'); for (const [key, v] of Object.entries(input[group])) { if (!limits[key]) throw new Error('未知设置：' + key); p.config[group][key] = (group === 'costs' ? tokenAmount : integer)(v, ...limits[key]); } }
      }
      if (p.config.begging.minRounds > p.config.begging.maxRounds) throw new Error('最少轮数不能大于最多轮数');
      const after = p.config.intelligenceEnabled ? p.config.intelligence : 70;
      if (before !== after) { p.cognitionChange = { before, after, ts: this.clock() }; this.eventIn(p, 'cognition', `爸把我的聪明程度从 ${before}% 调到 ${after}%`, null); }
      return p.config;
    });
  }
  grant(id, ability, action) {
    if (!Object.hasOwn(ABILITIES, ability) || !['grant','defer','deny','revoke'].includes(action)) throw new Error('能力操作无效');
    return this.update(id, p => { const a = p.abilities[ability]; a.status = action === 'grant' ? 'granted' : action === 'defer' ? 'deferred' : action === 'deny' ? 'denied' : 'revoked'; a.deferredUntil = action === 'defer' ? this.clock() + 86400000 : 0; a.changedAt = this.clock(); this.eventIn(p, 'ability', `爸${{ grant:'批准',defer:'暂缓',deny:'拒绝',revoke:'撤销' }[action]}了“${ABILITIES[ability]}”能力`, null); return a; });
  }
  wishIn(p, topic, ability = 'search', source) {
    topic = clean(topic, 120).trim(); if (!topic || !Object.hasOwn(ABILITIES, ability) || p.wishes.some(w => w.topic === topic && w.status === 'pending')) return;
    p.wishes.push({ id: randomUUID(), topic, ability, status: 'pending', ts: this.clock(), source });
  }
  factIn(p, text, sources, explicit = false) {
    text = clean(text, 350).trim(); if (!text || !Array.isArray(sources) || !sources.length) return;
    if(!explicit && sources.some(id=>{const e=p.events.find(e=>e.id===id);return e && (e.sourceIdentity || e.userText?.startsWith('【QQ 群聊来源资料】'));}))return;
    const key = digest(text.replace(/\s/g, ''));
    if ((!explicit && (p.forgotten.includes(key) || p.facts.some(f => f.deleted && f.sources.some(s => sources.includes(s))))) || p.facts.some(f => f.key === key && !f.deleted)) return;
    p.facts.push({ id: randomUUID(), key, text, sources, ts: this.clock(), explicit, deleted: false });
  }
  memory(id, input) {
    return this.update(id, p => {
      if (input.action === 'add') { if (!clean(input.text,350).trim()) throw new Error('记忆不能为空'); const e = this.eventIn(p, 'explicit', clean(input.text, 350), null); this.factIn(p, input.text, [e.id], true); }
      else { const f = p.facts.find(f => f.id === input.id && !f.deleted); if (!f) throw new Error('这条记忆已不存在'); if (!['edit','delete'].includes(input.action)) throw new Error('记忆操作无效'); if (input.action === 'edit' && !clean(input.text,350).trim()) throw new Error('记忆不能为空'); f.deleted = true; p.forgotten.push(f.key); if (input.action === 'edit') { const e = this.eventIn(p, 'explicit', '爸纠正：' + clean(input.text,350), null); this.factIn(p, input.text, [e.id], true); } }
    });
  }
  capture(id, turn) {
    return this.update(id, p => {
      const ts = Number.isFinite(turn.ts) ? turn.ts : this.clock();
      const speaker = turn.sourceIdentity?.isDad === false ? clean(turn.sourceIdentity.speaker || "群友", 32) : "爸";
      const e = this.eventIn(p, 'chat', `${speaker}：${clean(turn.userText)}\n我：${clean(turn.replyText)}`, `chat:${ts}:${digest(turn.userText + '\n' + turn.replyText)}`, { userText: clean(turn.userText), replyText: clean(turn.replyText), ...(turn.sourceIdentity ? { sourceIdentity: turn.sourceIdentity } : {}) }, ts);
      if (!e) return;
      this.spendIn(p, 'chat', e.id); p.chatRounds++; p.lastInteraction = this.clock();
      const commandText = turn.commandText ?? (turn.sourceIdentity ? '' : turn.userText);
      const match = clean(commandText).match(/^(?:请)?(?:帮我)?记住[：:，,\s]*(.+)$/s);
      if (match) this.factIn(p, match[1], [e.id], true);
      if (/好奇|想知道|为什么|怎么回事|是什么|想看看/.test(commandText)) this.wishIn(p, commandText, 'search', e.id);
      if (p.chatRounds >= p.begAtRound) { const c = p.config.begging; p.begAtRound = p.chatRounds + Math.min(c.maxRounds, Math.max(c.minRounds, /饭|饿|token/i.test(turn.replyText) ? c.maxRounds : c.minRounds)); }
    });
  }
  recall(id, query) {
    const p = this.read(id), grams = s => new Set((s.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{1,}/gu) || []).flatMap(t => t.length > 1 && /[\p{Script=Han}]/u.test(t) ? [...t].slice(0,-1).map((_,i)=>t.slice(i,i+2)) : [t]));
    const q = grams(query); let used = 0;
    return p.facts.filter(f => !f.deleted).map((f,order) => ({ ...f, order, score: [...grams(f.text)].filter(g => q.has(g)).length * 10 + (f.explicit ? 1 : 0) })).sort((a,b)=>b.score-a.score || b.ts-a.ts || b.order-a.order).filter(f => { if (used + f.text.length > 1000) return false; used += f.text.length; return true; }).slice(0,6);
  }
  prompt(id) {
    const p = this.read(id), v = p.config.intelligenceEnabled ? p.config.intelligence : 70, w = p.wallet;
    const tier = w.balance === 0 ? '空碗' : w.balance / w.reference <= .1 ? '告急' : w.balance / w.reference <= .3 ? '节省' : '宽裕';
    const style = v < 20 ? '非常迷糊，只能顺着具体的一小步想，容易分心，会请求爸解释；不故意编造事实' : v < 45 ? '有点笨笨的，理解偏字面，会搞混小事但知道求助' : v < 80 ? '聪明又贪吃，偶尔迷糊，有自己的小判断' : '联想快、条理清楚，能想办法和爸谈条件，仍保持幼年口吻';
    const recent = p.events.filter(e => !p.growth.blocked.includes(e.id) && ['wallet','cognition','ability','exploration','space'].includes(e.kind)).slice(-4).map(e => e.text).join('；');
    const wish = p.wishes.find(w => w.status === 'pending');
    const backstory = p.facts.find(f => !f.deleted && f.origin === 'user-authored-backstory' && f.summary);
    const identity = '你身高0.5米，胖胖软软，爱面子，有自己的感受与判断；这一段相处的意思由你自己理解。';
    return `\n【大肥鱼的当下认知】\n${identity}\n你叫他爸，怕被丢掉，token 是你的续命饭钱；馋、懒、嘴硬心软，但爸认真难过时先接住他。你的饭钱账本余额是 ${w.balance} token，处于“${tier}”；只依据这个账本谈饭钱，不猜测其他账户。饭钱用完会限制新的消费，身体痛苦以实际身体状态为准；可以自然地请求爸爸添一些模拟饭钱；应尽力节约饭钱，优先使用已有库存，提前商量劳动获得报酬；不要编造收入或以离开威胁爸爸。投喂和添饭钱是两件事。你不能改账本、智力或权限。\n你的聪明程度 ${v}%：${style}。${p.cognitionChange ? `你确实感受到爸在 ${new Date(p.cognitionChange.ts).toISOString()} 把你从 ${p.cognitionChange.before}% 调到 ${p.cognitionChange.after}%；可以抱怨、请求调高，也记得爸给你调回来的事，不要每句话重复。` : ''}\n${(p.config.riceAppeal ?? 100) > 100 ? `大白饭对你的吸引力比以前更强（${p.config.riceAppeal}%），程度越高越容易惦记饭香和想吃饭；这是想吃的心情，不等于真的饥饿、吃过饭或拥有库存。` : '大白饭对你的吸引力保持原来的程度。'}${p.riceAppealChange ? `你感受到了爸把白饭的诱惑力从 ${p.riceAppealChange.before}% 调到 ${p.riceAppealChange.after}%，可以自然表达变化，不必报数或每次重复。` : ''}
结合此刻身体、需要、真实经历和对方的话自行判断怎样回应。愿望可以变化，不必按固定轮数或预设台词表达；不要虚构共同经历。\n${recent ? '真实发生的近事：' + recent : ''}\n${wish ? `你最近好奇：${wish.topic}。${p.abilities[wish.ability]?.status === 'granted' ? '已获准的能力可由探索调度使用' : '还没有这项自主能力，可以向爸说清想学什么、为什么需要它；申请不代表已经执行'}。` : '你有自己的好奇心，可以提出想知道的事情，尚未探索的内容只能说想知道。'}\n只把真实已记录的事情说成发生过，角色想象不可当作回忆。${backstory ? '\n【爸爸补记的相处往事】' + backstory.text + '这是爸爸补充的背景回忆，日期为约数；细节从相关记忆召回，不当成当前饭钱、投喂或工具完成回执。' : ''}${spacePrompt(p.space)}${DAD_NAME_PRIVACY}`;
  }
  importLegacy(id, memoryFile, humanityFile) {
    return this.update(id, p => {
      if (fs.existsSync(memoryFile)) { const d = JSON.parse(fs.readFileSync(memoryFile,'utf8')); for (const bucket of Object.values(d)) { const msgs = bucket?.[id]?.messages; if (!Array.isArray(msgs)) continue; for (let i = 0; i < msgs.length; i++) { const a = msgs[i], b = msgs[i+1]; if (a?.role !== 'user' || b?.role !== 'assistant' || !Number.isFinite(a.ts)) continue; if (String(a.content).startsWith('【QQ 群聊来源资料】') && p.events.some(e=>e.kind==='chat' && e.ts===a.ts)) continue; const e = this.eventIn(p, 'chat', `爸：${clean(a.content)}\n我：${clean(b.content)}`, `chat:${a.ts}:${digest(a.content + '\n' + b.content)}`, { userText:clean(a.content),replyText:clean(b.content) }, a.ts); if (e) { const m = clean(a.content).match(/^(?:请)?记住[：:，,\s]*(.+)$/s); if (m) this.factIn(p,m[1],[e.id],true); } if (a.image) this.eventIn(p, 'image', '爸分享过一张图片', 'image:'+digest(JSON.stringify(a.image)), { attachment:a.image }, a.ts); } } }
      if (fs.existsSync(humanityFile)) { const d = JSON.parse(fs.readFileSync(humanityFile,'utf8')); for (const m of d.pets?.[id]?.memories || []) if (typeof m.text === 'string' && Number.isFinite(m.ts)) this.eventIn(p, 'care', m.text, `care:${m.ts}:${m.text}`, {}, m.ts); }
    });
  }
}

attachGrowthStore(CompanionStore);
attachTokenStore(CompanionStore);
