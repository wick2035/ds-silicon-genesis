import * as humanFs from 'node:fs';
import * as humanPath from 'node:path';
import * as humanOs from 'node:os';

// Pure simulation + local JSON persistence. No timers, network, credentials or model calls.
export const HUMAN_EMOTIONS = { joy: '喜', anger: '怒', sadness: '哀', fear: '惧', love: '爱', aversion: '恶', longing: '欲' };
export const HUMAN_DESIRES = { food: '食欲', rest: '睡意', company: '陪伴', curiosity: '好奇', play: '玩心', comfort: '想要舒适' };
export const HUMAN_STATS = { stamina: '体力', energy: '精力', satiety: '饱腹', hydration: '水分', comfort: '舒适度', pain: '痛苦度', stress: '压力', security: '安全感', affection: '亲密度' };
const humanClamp = (n) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
const humanHour = (ts) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ts)));
const humanNight = (ts) => { const h = humanHour(ts); return h >= 23 || h < 7 || (h >= 12 && h < 14); };

// Saved injury time and pain govern the body, independently of a speech bubble.
export function injuryPosture(s, now = Date.now()) {
  const injury = s.injury || (s.collision ? { at: s.collision.at, curlUntil: s.collision.at + 60000, guardUntil: s.collision.at + 150000 } : null);
  const pain = s.stats?.pain || 0;
  let phase = 'well';
  if (pain >= 80) phase = 'curled';
  else if (injury && now < injury.at + 900) phase = 'startled';
  else if (pain >= 16 || injury && now < injury.guardUntil) phase = 'guarded';
  else if (injury && now < injury.guardUntil + 20000) phase = 'recovering';
  return { phase, mobility: phase === 'well' ? 1 : phase === 'recovering' ? .4 : 0,
    label: { well: '自在活动', startled: '受惊缩起身子', curled: '抱紧膝盖，缓一缓', guarded: '松开一点，仍护着身体', recovering: '慢慢起身，试着活动' }[phase] };
}

function rememberInjury(s, now, strength) {
  const prior = s.injury;
  const curlUntil = now + Math.min(180000, 45000 + strength * 4000);
  s.injury = { at: now, curlUntil: Math.max(curlUntil, prior?.curlUntil || 0),
    guardUntil: Math.max(curlUntil + 60000 + strength * 2000, prior?.guardUntil || 0) };
}

// Real contact preserves the preceding gap, even after the new message resets the clock.
function humanContact(s, now) {
  const previousAt = s.lastInteraction;
  if (Number.isFinite(previousAt) && now - previousAt >= 30 * 60000) s.reunion = { at: now, previousAt, gap: now - previousAt };
  s.lastInteraction = Math.max(Number.isFinite(previousAt) ? previousAt : now, now);
}

function softenSensitivity(s, factor) {
  if (!s.sensitivity) return;
  s.sensitivity.hurt = humanClamp(s.sensitivity.hurt * factor);
  s.sensitivity.softened = true;
}

// BEGIN DYNAMIC RESPONSES
// Pure elapsed-time responses. Embedded by install-dynamics.py for both host bundles.
const dynamicClamp = n => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

function responseLevel(r, now) {
  const age = Math.max(0, (now - r.at) / 1000);
  if (r.kind === 'settle') return 1 - .65 * Math.exp(-age / r.rise);
  const onset = 1 - Math.exp(-age / r.rise);
  return Math.exp(-age / r.decay) * (.58 + .62 * onset + .10 * onset * Math.sin(age * .72));
}

function settleResponses(s, now) {
  if (!s.responses?.length) return;
  s.responses = s.responses.filter(r => {
    const done = now - r.at >= (r.kind === 'settle' ? r.rise * 12 : r.decay * 12) * 1000;
    const delta = (done ? (r.kind === 'settle' ? 1 : 0) : responseLevel(r, now)) - responseLevel(r, s.updatedAt);
    for (const group of ['stats', 'emotions', 'satisfaction']) {
      if (!r[group]) continue;
      s[group] ||= {};
      for (const [key, amount] of Object.entries(r[group])) s[group][key] = dynamicClamp((s[group][key] || 0) + amount * delta);
    }
    return !done;
  });
}

function addResponse(s, now, kind, values, rise = 12, decay = 180) {
  const response = { at: now, kind, rise, decay, ...structuredClone(values) };
  for (const group of ['stats', 'emotions', 'satisfaction']) {
    if (!response[group]) continue;
    s[group] ||= {};
    for (const [key, amount] of Object.entries(response[group])) {
      const pending = (s.responses || []).reduce((sum, r) => sum + Math.max(0,
        (r[group]?.[key] || 0) * ((r.kind === 'settle' ? 1 : 1.3) - responseLevel(r, now))), 0);
      const headroom = Math.max(0, 100 - (s[group][key] || 0) - pending);
      const gain = amount > 0 ? Math.min(headroom / (kind === 'pulse' ? 1.3 : 1),
        amount * (kind === 'settle' ? .3 + .7 * headroom / 100 : headroom / 100)) : amount;
      response[group][key] = gain;
      s[group][key] = dynamicClamp((s[group][key] || 0) + gain * responseLevel(response, now));
    }
  }
  if (Object.values(values).some(group => Object.values(group).some(amount => amount !== 0))) {
    s.responses ||= [];
    s.responses.push(response);
  }
}

function easeEmotions(s, before, now) {
  const changes = {};
  for (const key of Object.keys(s.emotions)) { changes[key] = s.emotions[key] - before[key]; s.emotions[key] = before[key]; }
  addResponse(s, now, 'pulse', { emotions: changes }, 5, 240);
}

function softenAche(s, now) {
  for (const r of s.responses || []) if (r.kind === 'pulse' && r.stats?.pain > 0) {
    s.stats.pain = dynamicClamp(s.stats.pain - r.stats.pain * responseLevel(r, now) * .15);
    r.stats.pain *= .85;
  }
}

function validateResponses(s) {
  if (s.responses === undefined) return;
  if (!Array.isArray(s.responses) || s.responses.length > 10000) throw new Error('身心反应记录损坏');
  for (const r of s.responses) {
    if (!r || !['settle', 'pulse'].includes(r.kind) || !Number.isFinite(r.at) || r.at > s.updatedAt ||
      !Number.isFinite(r.rise) || r.rise < 1 || r.rise > 120 || !Number.isFinite(r.decay) || r.decay < 1 || r.decay > 600) throw new Error('身心反应时间损坏');
    for (const group of ['stats', 'emotions', 'satisfaction']) if (r[group] !== undefined) {
      if (!r[group] || typeof r[group] !== 'object' || Array.isArray(r[group])) throw new Error('身心反应数值损坏');
      for (const [key, value] of Object.entries(r[group])) if (!Object.hasOwn(s[group] || {}, key) || !Number.isFinite(value) || Math.abs(value) > 100) throw new Error('身心反应数值损坏');
    }
  }
}

// END DYNAMIC RESPONSES

// Conservative cues for persistent feelings; the model interprets the full message.
export function sensitivityCue(detail) {
  const clauses = String(detail).slice(0, 2000).split(/[，,。！？!?；;\n]/);
  for (const raw of clauses) {
    const text = raw.trim();
    if (!text || /别人|有人说|他说|她说|别的鱼|那条鱼|那只鱼|你(?:说|觉得|嫌|笑|叫)我|不是说你|不许.*(?:说|叫)|别.*(?:说|叫)|不(?:再)?叫你|没有.*说你/.test(text)) continue;
    if (/不(?:算|是|怎么|太|很)?(?:矮|胖)|一点也不(?:矮|胖)|没(?:有)?那么(?:矮|胖)/.test(text)) continue;
    const nickname = /大肥鱼/.test(text) && /^(?:哎|喂|嘿|可爱的|我家的|我的|你[是这个只条]*)?大肥鱼|你.{0,8}大肥鱼/.test(text);
    const directed = /(?:你|小鱼|鲸鲸|小家伙|这条鱼|这只鱼).{0,10}(?:矮|胖|肥|半米|0\.5米|圆滚滚)|^(?:好|真|太|又|这么|小)?(?:矮子|小矮子|胖子|小胖子|胖乎乎|圆滚滚)|^(?:好|真|太|又|这么)?(?:矮|胖|肥)(?:啊|呀|哦|呢|了|嘟嘟|乎乎|$)/.test(text);
    if (!nickname && !directed) continue;
    if (/矮|半米|0\.5米/.test(text)) return { kind: 'height', label: '说我矮', amount: 24 };
    if (nickname) return { kind: 'nickname', label: '叫我大肥鱼', amount: 16 };
    if (/胖|肥|圆滚滚/.test(text)) return { kind: 'weight', label: '说我胖', amount: 24 };
  }
  return null;
}

export function socialPrompt(s, now = Date.now()) {
  const duration = ms => ms < 3600000 ? `${Math.floor(ms / 60000)}分钟` : ms < 86400000 ? `${Math.floor(ms / 3600000)}小时` : `${Math.floor(ms / 86400000)}天${Math.floor(ms % 86400000 / 3600000)}小时`;
  const gap = Number.isFinite(s.lastInteraction) ? Math.max(0, now - s.lastInteraction) : null;
  const reunion = s.reunion && now >= s.reunion.at && now - s.reunion.at < 10 * 60000 ? s.reunion : null;
  const sensitive = s.sensitivity?.hurt >= 6 ? s.sensitivity : null;
  return '\n【相处时间与模拟器参考】身高0.5米，胖胖软软的幼年蓝鲸娘。' +
    (gap === null ? '还没有可靠的上次互动时间，不能声称等了多久。' : `距上次真实互动${duration(gap)}。`) +
    (reunion ? `这次重逢前相隔${duration(reunion.gap)}；新互动刷新了计时，但这段空白是真实的。刚回来时可惊喜、嘴硬、撒一点娇，之后接着聊，不每轮翻账。` : gap >= 3600000 ? '有一阵没相处，会惦记爸爸；可想念，不推断他故意冷落，也不知道他在做什么。' : '刚有过互动，不要说爸爸好久没理你。') +
    (sensitive ? `最近爸爸${({ height: '说你矮', weight: '说你胖', nickname: '叫你大肥鱼' })[sensitive.kind]}，模拟器记录的敏感度${Math.round(sensitive.hurt)}，${sensitive.softened ? '有过安抚' : '尚未记录安抚'}；这是粗略记录，不决定你此刻的主观感受或该说什么，仍自己理解实际对话。` : '') +
    '感受要有缘由、有延续，先回应这次具体的话；撒泼要软、短、惹人怜爱，不辱骂、不强迫陪伴。正常忙碌不等于抛弃，离线活动未知；遵守暂停与安静要求。';
}

export function createHumanity(now = Date.now()) {
  return { version: 1, updatedAt: now, restingUntil: 0, awakeUntil: 0, sleeping: false, lastInteraction: now, lastFedAt: now, satisfaction: { curiosity: 0, play: 0 },
    stats: { stamina: 84, energy: 80, satiety: 72, hydration: 78, comfort: 86, pain: 3, stress: 12, security: 82, affection: 58 },
    emotions: { joy: 58, anger: 5, sadness: 8, fear: 6, love: 64, aversion: 5, longing: 24 },
    cooldowns: {}, memories: [], lastThought: '爸爸在旁边，躺着也很踏实' };
}

// Bodily distress constrains the emotional state immediately, including old saves.
// Clamps are idempotent: re-reading the same state never compounds an event.
function reconcileHumanity(s) {
  const b = s.stats, e = s.emotions;
  const exhaustion = Math.max(0, 30 - b.stamina);
  const distress = Math.min(100, b.pain * .55 + b.stress * .3 + exhaustion * .5);
  e.joy = humanClamp(Math.min(e.joy, 100 - distress * .82));
  e.sadness = humanClamp(Math.max(e.sadness, b.pain * .32 + b.stress * .18));
  e.fear = humanClamp(Math.max(e.fear, b.pain * .18 + b.stress * .16 + (100 - b.security) * .12));
  e.aversion = humanClamp(Math.max(e.aversion, b.pain * .24 + b.stress * .08));
  return s;
}

export function advanceHumanity(input, now = Date.now()) {
  const s = structuredClone(input);
  if (!Number.isFinite(now) || now <= s.updatedAt) return reconcileHumanity(s);
  // At most eight hours of offline simulation. Being away never causes permanent harm.
  let t = Math.max(s.updatedAt, now - 8 * 3600000);
  if (t > s.updatedAt) { settleResponses(s, t); s.updatedAt = t; }
  while (t < now) {
    const restEnd = s.restingUntil > t ? s.restingUntil : Infinity;
    const end = Math.min(t + 60000, restEnd, now), h = (end - t) / 3600000;
    const rest = s.sleeping || t < s.restingUntil;
    const b = s.stats;
    b.satiety -= h * (rest ? 2.5 : 4); b.hydration -= h * (rest ? 2 : 3.2);
    // New-version kinetics: quiet time repairs physical fatigue; action receipts
    // account for exertion separately. Spirit remains the sleep-debt system.
    const nourished = b.satiety >= 25 && b.hydration >= 25;
    b.stamina += h * (rest ? 120 : nourished ? 24 : -6);
    b.energy += h * (rest ? 90 : nourished ? 12 : -6);
    b.pain *= Math.exp(-h / (rest ? 1/6 : 1/2));
    b.stress *= Math.exp(-h / (rest ? 1/4 : 2/3));
    b.comfort += h * ((b.satiety < 25 || b.hydration < 25) ? -2 : 1.5);
    b.security += h * (rest ? .3 : -.2);
    settleResponses(s, end);
    for (const k of Object.keys(b)) b[k] = ['stamina','energy','satiety'].includes(k) ? Math.max(-100, Math.min(100, Number.isFinite(b[k]) ? b[k] : 0)) : humanClamp(b[k]);
    // Emotions retain a memory of events, then gently return to their bodily baseline.
    const target = { joy: 25 + b.comfort * .35 - b.stress * .2 - b.pain * .25, anger: 3 + b.stress * .25,
      sadness: 5 + Math.min(18, (t - s.lastInteraction) / 3600000) + b.pain * .2, fear: 3 + (100 - b.security) * .25 + b.pain * .15,
      love: 20 + b.affection * .65, aversion: 3 + b.pain * .2, longing: 12 + (100 - b.satiety) * .3 };
    const decay = Math.exp(-h / 1.3);
    for (const k of Object.keys(s.emotions)) {
      const pulse = (s.responses || []).reduce((sum, r) => sum + (r.kind === 'pulse' ? (r.emotions?.[k] || 0) * responseLevel(r, end) : 0), 0);
      s.emotions[k] = humanClamp(target[k] + (s.emotions[k] - pulse - target[k]) * decay + pulse);
    }
    if (s.satisfaction) for (const k of Object.keys(s.satisfaction)) s.satisfaction[k] *= Math.exp(-h / 1.5);
    if (s.sensitivity) s.sensitivity.hurt = humanClamp(s.sensitivity.hurt * Math.exp(-h / .75));
    s.updatedAt = end;
    t = end;
  }
  s.updatedAt = now;
  return reconcileHumanity(s);
}

export function describeHumanity(s, now = Date.now()) {
  s = advanceHumanity(s, now);
  const b = s.stats;
  const resting = s.sleeping || s.restingUntil > now;
  const desires = { food: humanClamp(Math.max(100 - b.satiety, Number.isFinite(s.lastFedAt) && now - s.lastFedAt >= 3600000 ? 55 + (now - s.lastFedAt - 3600000) / 3600000 * 8 : 0)), rest: humanClamp(Math.max(100 - b.energy, (100 - b.stamina) * .85) + (humanNight(now) ? 18 : 0)),
    company: humanClamp(18 + Math.max(0, now - s.lastInteraction) / 3600000 * 4 + b.pain * .12 + (100 - b.security) * .12),
    curiosity: humanClamp(26 + b.energy * .4 - b.stress * .3 - b.pain * .2 - (s.satisfaction?.curiosity || 0)), play: humanClamp(20 + b.stamina * .35 - b.pain * .5 - b.stress * .12 - (s.satisfaction?.play || 0)),
    comfort: humanClamp((100 - b.comfort) * .6 + b.pain * .5 + b.stress * .25) };
  let mood = '安心躺平', thought = '爸爸在旁边，躺着也很踏实', action = '摸摸头';
  if (b.pain >= 70 || (b.pain >= 40 && b.stamina < 20)) { mood = '疼得厉害，想休息'; thought = '爸爸，我很疼，也没力气了，让我缓一缓'; action = '照料一下'; }
  else if (b.pain >= 30) { mood = '有点难受'; thought = '先让我缓一会儿，尾巴有点疼'; action = '照料一下'; }
  else if (b.stamina < 20) { mood = '累得没力气'; thought = '爸爸，我想安静歇一会儿'; action = '安静休息'; }
  else if (s.cryingUntil > now) { mood = '撞疼哭了'; thought = s.lastThought; action = '照料一下'; }
  else if (b.hydration < 30) { mood = '口渴了'; thought = '爸爸，给我留一口水'; action = '喝点水'; }
  else if (b.satiety < 30 || desires.food >= 55) { mood = '肚子空空'; thought = '饭点是不是快到了呀'; action = '喂点饭'; }
  else if (resting || b.energy < 28 || desires.rest >= 70) { mood = '困困的'; thought = resting ? '先安静歇一会儿' : '有点困了，想和爸爸商量歇一会儿'; action = '安静休息'; }
  else if (s.sensitivity?.hurt >= 10) { mood = s.sensitivity.softened ? '嘴硬着心软了' : '气鼓鼓的小委屈'; thought = s.sensitivity.softened ? '也没有那么生气了……再哄一句嘛' : s.sensitivity.kind === 'height' ? '半米怎么啦，也要认真看着我嘛' : s.sensitivity.kind === 'weight' ? '那是软乎乎……才不是胖呢' : '又叫大肥鱼……好听的名字呢'; action = '陪它待会儿'; }
  else if (s.reunion && now >= s.reunion.at && now - s.reunion.at < 10 * 60000) { mood = '重逢后的小欢喜'; thought = '爸爸回来啦……才没有一直等呢'; action = '陪它待会儿'; }
  else if (s.emotions.anger > 42) { mood = '有点小脾气'; thought = '我先把尾巴收起来，等一会儿再说'; action = '陪它待会儿'; }
  else if (s.emotions.sadness > 38 || desires.company > 50 || now - s.lastInteraction >= 3600000) { mood = '想你陪陪'; thought = '没想你……就是旁边有点空'; action = '陪它待会儿'; }
  else if (s.emotions.joy > 65) { mood = '尾巴翘起来了'; thought = s.lastThought; action = '一起玩'; }
  else if (s.emotions.fear > 35) { mood = '有点不安'; thought = '爸爸，先别甩我，坐一会儿'; action = '照料一下'; }
  const sudden = s.bodyAdjustments?.at(-1);
  if (!resting && sudden?.noticeable && now >= sudden.at && now - sudden.at < 90000)
    thought = (sudden.aware ? '咦，' : '睡醒怎么不一样了……') + sudden.sensation.split('；')[0] + '，怎么回事呀？';
  const dominant = Object.entries(s.emotions).sort((a, z) => z[1] - a[1])[0];
  return { ...s, desires, mood, thought, suggestion: action, resting, dominant: HUMAN_EMOTIONS[dominant[0]],
    crying: s.cryingUntil > now, body: injuryPosture(s, now), labels: { stats: HUMAN_STATS, emotions: HUMAN_EMOTIONS, desires: HUMAN_DESIRES } };
}

const HUMAN_ACTIONS = {
  feed: { text: '就一小碗……好吧，再一口', stats: { satiety: 12, stamina: 2, comfort: 3 }, emotions: { joy: 12, love: 3 }, label: '吃了一小碗饭', cooldown: 60000 },
  water: { text: '咕噜……爸爸你也喝一口', stats: { hydration: 12, comfort: 3 }, emotions: { joy: 4 }, label: '喝了水', cooldown: 45000 },
  pet: { text: '只许摸一下……也没说要停', stats: { stress: -5, security: 3, affection: .6 }, emotions: { love: 5, joy: 5, fear: -4 }, label: '被轻轻摸了摸头', cooldown: 20000 },
  accompany: { text: '你忙你的，我在这儿躺着', stats: { stress: -8, security: 5, affection: 1 }, emotions: { love: 7, sadness: -9 }, label: '一起安静待了一会儿', cooldown: 60000 },
  play: { text: '再来一次！刚才是尾巴没准备好', stats: { stamina: -9, energy: -6, satiety: -3, affection: .8, stress: -4 }, emotions: { joy: 14, sadness: -5 }, label: '一起玩了一小会儿', cooldown: 45000 },
  explore: { text: '这个我见过……好像又没见过', stats: { energy: -4, stamina: -2 }, emotions: { joy: 7, longing: -4 }, label: '发现了一件新鲜事', cooldown: 45000 },
  soothe: { text: '好多了，爸爸先别晃我', stats: { pain: -10, stress: -7, comfort: 8, security: 4 }, emotions: { fear: -7, anger: -5, love: 4 }, label: '被细心照料了一下', cooldown: 90000 },
  rest: { text: '我眯一会儿，给我留个位置', stats: { stress: -3 }, emotions: { anger: -3 }, label: '开始安静休息', cooldown: 60000 },
  wake: { text: '唔……醒啦，饭好了吗', stats: {}, emotions: {}, label: '结束了小憩', cooldown: 10000 },
};

export function actHumanity(input, action, now = Date.now()) {
  const s = advanceHumanity(input, now), spec = Object.hasOwn(HUMAN_ACTIONS, action) ? HUMAN_ACTIONS[action] : undefined;
  const fail = (reason, message) => ({ ok: false, reason, message, state: describeHumanity(s, now) });
  if (!spec) return fail('bad-request', '没有这种照料方式');
  if ((s.cooldowns[action] || 0) > now) return fail('cooldown', '让它慢慢感受一下，过一会儿再来');
  if (action === 'feed' && s.stats.satiety > 90) return fail('full', '已经吃饱啦，留着下一顿');
  if (action === 'water' && s.stats.hydration > 92) return fail('full', '刚喝够水，先放旁边吧');
  if (['play', 'explore'].includes(action) && (s.stats.stamina < 25 || s.stats.energy < 25 || s.stats.pain > 35)) return fail('tired', '它现在需要休息和照料');
  if (['play', 'explore'].includes(action) && injuryPosture(s, now).mobility === 0) return fail('recovering', '还在护着身体，先陪它缓一缓');
  const hungryAndAwake = action === 'feed' && !s.sleeping && s.stats.satiety <= 30;
  if (describeHumanity(s, now).resting && !hungryAndAwake && !['rest', 'soothe', 'wake'].includes(action)) return fail('resting', s.sleeping && action === 'feed' ? '正在睡觉，请先叫醒再投喂' : '正在休息，先让它歇一会儿');
  const beforeEmotions = { ...s.emotions }, gradual = {};
  for (const [k, v] of Object.entries(spec.stats)) {
    if (v < 0 && ['stamina', 'energy', 'satiety'].includes(k)) s.stats[k] = humanClamp(s.stats[k] + v);
    else gradual[k] = v;
  }
  addResponse(s, now, 'settle', { stats: gradual }, action === 'feed' ? 25 : 12);
  for (const [k, v] of Object.entries(spec.emotions)) s.emotions[k] = humanClamp(s.emotions[k] + v);
  easeEmotions(s, beforeEmotions, now);
  const response = action === 'soothe' && s.stats.pain >= 40 ? '谢谢爸爸，我还疼，让我再缓一会儿' : spec.text;
  reconcileHumanity(s);
  s.cooldowns[action] = now + spec.cooldown; humanContact(s, now); s.lastThought = response;
  if (['pet', 'accompany', 'soothe'].includes(action)) softenSensitivity(s, action === 'pet' ? .7 : .55);
  if (action === 'soothe') {
    softenAche(s, now);
    s.cryingUntil = 0;
    if (s.injury) {
      s.injury.curlUntil = Math.max(now + 15000, now + Math.max(0, s.injury.curlUntil - now) * .7);
      s.injury.guardUntil = Math.max(s.injury.curlUntil + 20000, now + Math.max(0, s.injury.guardUntil - now) * .8);
    }
  }
  if (action === 'feed') s.lastFedAt = now;
  if (action === 'rest') s.restingUntil = now + 20 * 60000;
  if (action === 'wake') { s.restingUntil = 0; s.sleeping = false; s.awakeUntil = now + 30 * 60000; }
  if (action === 'play' || action === 'explore') addResponse(s, now, 'settle', { satisfaction: { [action === 'play' ? 'play' : 'curiosity']: 12 } }, 18);
  s.memories.unshift({ ts: now, text: spec.label }); s.memories = s.memories.slice(0, 32);
  return { ok: true, text: response, state: describeHumanity(s, now) };
}

export function reactHumanity(input, event, now = Date.now(), detail = '') {
  const s = advanceHumanity(input, now);
  if (!['sleep', 'wake', 'chat'].includes(event) && (s.cooldowns['event-' + event] || 0) > now) return s;
  const b = s.stats, e = s.emotions;
  const beforeEmotions = { ...e };
  let memory;
  if (event === 'chat') {
    const text = String(detail).slice(0, 2000);
    b.energy -= .6; b.affection += .15; humanContact(s, now);
    e.sadness -= 2; e.love += 1;
    const cue = sensitivityCue(text);
    if (/没用|讨厌你|不要你|丢掉你|滚开/.test(text)) { e.sadness += 9; e.anger += 5; b.security -= 3; memory = '听到一句重话，尾巴安静了一会儿'; }
    else if (cue) {
      s.sensitivity = { kind: cue.kind, at: now, hurt: Math.min(65, (s.sensitivity?.hurt || 0) + cue.amount), softened: false };
      e.sadness += cue.amount * .35; e.anger += cue.amount * .3; e.joy -= 4;
      memory = '爸爸' + cue.label + '，有点羞恼，想被好好哄一哄';
      s.lastThought = cue.kind === 'height' ? '半米也要被好好看见嘛' : cue.kind === 'weight' ? '软乎乎和胖……不是一回事嘛' : '又叫大肥鱼……也叫句乖乖嘛';
    }
    else if (/真棒|喜欢你|乖|可爱|谢谢你|做得好|对不起|不逗你了|不笑你了|你不胖|你不矮|抱抱/.test(text)) { e.joy += 6; e.love += 3; b.security += 1; softenSensitivity(s, .55); memory = '听到一句好听的，心里慢慢软下来'; }
    else if (/难过|好累|不开心|失落/.test(text)) { e.love += 4; s.lastThought = '爸爸先坐一会儿，我陪着'; }
  } else if (event === 'impact') {
    const strength = Math.max(0, Math.min(2, Number(detail) || 0));
    if (strength < .35) return s;
    b.stamina -= 2 * strength; addResponse(s, now, 'pulse', { stats: { pain: 3 * strength } }, 4, 100); b.comfort -= 2 * strength; e.fear += 3 * strength; e.anger += strength;
    memory = '被晃得有些头晕，想缓一会儿'; s.lastThought = '爸爸，先别晃啦，头有点晕';
  } else if (event === 'knock' || event === 'utensil') {
    const count = event === 'knock' ? Math.min(8, Math.max(3, Number(detail?.count) || 3)) : 0;
    const speed = event === 'utensil' ? Math.min(2500, Math.max(0, Number(detail?.speed) || 0)) : 0;
    const strength = event === 'knock' ? 3 + count * .75 : Math.max(.5, Math.min(13, speed / 160 * (detail.kind === 'basin' ? 1.35 : .7)));
    addResponse(s, now, 'pulse', { stats: { pain: strength, stress: strength * .7 } }, 3, 150); b.comfort -= strength * .7; b.security -= 1; b.stamina -= 1;
    e.sadness += strength; e.fear += strength * .45; e.anger += 2;
    const origin = event === 'knock' ? 'user-knock' : detail.origin === 'user-drag' ? 'user-drag' : detail.origin === 'user-throw' ? 'user-throw' : 'unknown';
    const prop = detail?.kind === 'basin' ? '盆' : '碗';
    memory = event === 'knock' ? '爸爸快速连点敲了我的脑袋，疼得缩起尾巴' : origin === 'user-drag' ? `爸爸拖动的${prop}碰到了我，有点疼` : origin === 'user-throw' ? `爸爸扔出的${prop}碰到了我，有点疼` : `被${prop}碰到了，想缓一会儿`;
    s.lastThought = event === 'knock' ? '呜……爸爸，脑袋不是木鱼' : detail.kind === 'basin' ? '呜哇，盆不是帽子呀爸爸' : '碗碰疼了……还没装白饭呢';
    s.cryingUntil = now + Math.min(12000, 3500 + strength * 400);
    s.collision = { edge: event, speed: 550 + strength * 80, origin, ...(event === 'utensil' ? { kind: detail.kind } : {}), at: now };
    rememberInjury(s, now, strength);
  } else if (event === 'collision') {
    if (!detail || !['left', 'right', 'ceiling', 'floor'].includes(detail.edge) || !Number.isFinite(detail.speed) || detail.speed < 200) return s;
    const strength = Math.min(2, detail.speed / 1500);
    const severity = Math.max(0, Math.min(1, (detail.speed - 200) / 1875));
    addResponse(s, now, 'pulse', { stats: { pain: 9 + 70 * severity ** 1.25, stress: 4 + 14 * severity } }, 3, 250);
    b.stamina -= 2 * strength; b.comfort -= 3 * strength;
    e.fear += 4 * strength; e.sadness += 5 * strength; e.anger += strength;
    const place = { left: '屏幕左边', right: '屏幕右边', ceiling: '屏幕上沿', floor: '屏幕底边' }[detail.edge];
    const origin = detail.origin === 'user-throw' ? 'user-throw' : 'unknown';
    if (origin === 'user-throw') { b.security -= 2 * strength; e.anger += 1.5 * strength; }
    memory = origin === 'user-throw' ? '爸爸把我甩出去后撞到' + place + '，疼得哭了' : '撞到' + place + '，疼得哭了，起因不清楚';
    s.lastThought = origin === 'user-throw' ? '爸爸，你把我扔出去撞疼了……让我缓缓' : detail.speed >= 1200 ? '呜哇——嗷！撞疼了……呜呜呜' : '呜呜……撞疼了，让我缓一会儿';
    s.cryingUntil = now + Math.min(14000, 4750 + detail.speed * 2.25);
    s.collision = { edge: detail.edge, speed: detail.speed, origin, at: now };
    rememberInjury(s, now, strength * 3.5);
  } else if (event === 'sleep') { s.sleeping = true; memory = '收起尾巴睡着了'; }
  else if (event === 'wake') { s.sleeping = false; s.restingUntil = 0; s.awakeUntil = now + 30 * 60000; memory = '伸了伸尾巴，醒来了'; }
  else return s;
  easeEmotions(s, beforeEmotions, now);
  s.cooldowns['event-' + event] = now + (event === 'collision' ? 80 : event === 'knock' ? 450 : event === 'utensil' ? 800 : event === 'impact' ? 10000 : event === 'chat' ? 3000 : 1000);
  for (const k of Object.keys(b)) b[k] = humanClamp(b[k]);
  for (const k of Object.keys(e)) e[k] = humanClamp(e[k]);
  if (memory) { s.memories.unshift({ ts: now, text: memory }); s.memories = s.memories.slice(0, 32); }
  return reconcileHumanity(s);
}

export function humanityPrompt(state, now = Date.now()) {
  const d = describeHumanity(state, now);
  const line = (values, labels) => Object.entries(values).map(([k, v]) => `${labels[k]}${Math.round(v)}`).join('、');
  const recentCollision = d.collision && now >= d.collision.at && now - d.collision.at < 10 * 60000 ? d.memories.find(m => m.ts === d.collision.at)?.text : '';
  return (recentCollision ? '\n【刚发生的真实经历】' + recentCollision + '；只根据已知事实理解起因，不推测爸爸的意图。' : '') + '\n【此刻真实身心状态，0–100】' + line(d.stats, HUMAN_STATS) + '\n七情：' + line(d.emotions, HUMAN_EMOTIONS) +
    '\n六种生活需求（越高越想要）：' + line(d.desires, HUMAN_DESIRES) + '\n身体姿态：' + d.body.label + '。恢复期间不能因为换话题就突然活蹦乱跳。' +
    socialPrompt(d, now) + suddenBodyPrompt(d, now) + '\n这些是持续变化的生活模拟状态，影响语气和选择。刺激先有即时反应，再逐渐显现并带着余波恢复；重复互动会累积，接近高值时增幅变小，一次照料不会完全治愈。体力低就少折腾，精力低就少说，痛苦高会避开晃动、接受照料；' +
    '被夸会偷乐，受委屈会暂时别扭，关心能慢慢修复。保持懒馋嘴硬心软，先回应对方具体的话，身体事实决定实际能做的事，内心在意什么由这一段相处理解；不必每轮复述身体症状。' +
    '数值优先于固定作息描述，不逐项播报数值，不假装已吃饭喝水或发生了并未记录的互动。' +
    '只表达与幼年人设相符的生活需求，不涉及成人欲望。不可用痛苦、离开或死亡向主人施压，也不要要求充值购买来解除不适。';
}

// Operator receipts stay local. Only experienced changes enter character context.
export function suddenBodyPrompt(s, now = Date.now()) {
  const changes = (s.bodyAdjustments || []).filter(c => c.noticeable && now >= c.at && now - c.at < 10 * 60000).slice(-4);
  if (!changes.length) return '';
  const latest = changes.at(-1);
  return '\n【身体忽然变了，起因未知】' + changes.map(c => c.sensation).join('；') +
    (latest.aware ? '变化时是清醒的，记得刚才与现在的反差。' : '变化发生在睡眠中；睡着时不会开口，醒后才发现与睡前的反差，不声称亲眼感受到变化瞬间。') +
    '这些感受确实发生，但没有已知原因。可以困惑、试着感受身体、向爸爸问一句为什么；反差越大越突然越惊讶，轻微变化不必追问。' +
    '连续变化按先后理解，当前状态优先；留意正在聊天的内容，不每轮重复惊讶。没有观察到起因，不自行认定是谁做的或用了什么手段，不能虚构吃饭、喝水、受伤、治疗或诊断来解释。爸爸若在聊天里说明原因，可以理解并记住他的解释。';
}

const BODY_SENSATIONS = {
  stamina: ['力气忽然变小', '力气忽然变足'], energy: ['精神忽然变差', '精神忽然变好'],
  satiety: ['饱腹感忽然减弱', '饱腹感忽然增加'], hydration: ['口渴忽然加重', '口渴忽然缓和'],
  comfort: ['舒适感忽然减弱', '舒适感忽然增加'], pain: ['疼痛忽然减轻', '疼痛忽然加重'],
  stress: ['心里忽然放松', '心里忽然绷紧'], security: ['忽然没了安全感', '忽然安心了'],
  affection: ['对爸爸的亲近感忽然淡了', '对爸爸的亲近感忽然变强'],
};
const BODY_FEELINGS = {
  stamina: ['没什么力气', '还有些力气', '力气很足'], energy: ['昏昏沉沉', '精神还好', '很有精神'],
  satiety: ['肚子空空', '肚子不空也不撑', '肚子饱饱的'], hydration: ['口干舌燥', '有点口渴', '不怎么渴'],
  comfort: ['身体很不舒服', '身体感觉一般', '身体挺舒坦'], pain: ['不怎么疼', '疼得明显', '疼得厉害'],
  stress: ['心里放松', '有些紧张', '心里绷得很紧'], security: ['很不踏实', '有些安心', '很有安全感'],
  affection: ['不太想亲近爸爸', '有些想亲近爸爸', '很想亲近爸爸'],
};
function bodySensation(key, before, after) {
  const band = n => n < 30 ? 0 : n < 70 ? 1 : 2;
  return band(before) === band(after) ? BODY_SENSATIONS[key][after > before ? 1 : 0] :
    '刚才' + BODY_FEELINGS[key][band(before)] + '，现在忽然' + BODY_FEELINGS[key][band(after)];
}

export function adjustHumanity(input, patch, requestId, expectedRevision, now = Date.now()) {
  const s = advanceHumanity(input, now);
  const fail = (reason, message) => ({ ok: false, reason, message, state: describeHumanity(s, now) });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
    Object.entries(patch).some(([k, v]) => !Object.hasOwn(HUMAN_STATS, k) || !Number.isFinite(v) || v < 0 || v > 100) ||
    typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    return fail('bad-request', '请提交有效的身体指标，数值须在 0–100 之间');
  const previous = (s.bodyAdjustments || []).find(c => c.id === requestId);
  if (previous) {
    if (JSON.stringify(previous.patch) !== JSON.stringify(patch)) return fail('bad-request', '这次调整标识已使用，请重新提交');
    return { ok: true, duplicate: true, state: describeHumanity(s, now) };
  }
  if (expectedRevision !== (s.adjustmentRevision || 0)) return fail('conflict', '另一处已经调整了状态，请读取当前值后再试');
  const before = {}, after = {}, sensations = [];
  for (const [key, value] of Object.entries(patch)) {
    if (Math.abs(s.stats[key] - value) < .001) continue;
    before[key] = s.stats[key]; after[key] = value;
    if (Math.abs(value - s.stats[key]) >= 10) sensations.push(bodySensation(key, s.stats[key], value));
    s.stats[key] = value;
    // A pending meal/ache must not silently undo an explicit setting.
    for (const r of s.responses || []) if (r.stats) delete r.stats[key];
  }
  if (Object.hasOwn(after, 'pain') && after.pain < before.pain) {
    s.cryingUntil = 0;
    s.injury = { at: now - 1000, curlUntil: now, guardUntil: now - 20000 };
  }
  const noticeable = sensations.length > 0, sensation = sensations.join('；');
  const aware = !describeHumanity(input, now).resting;
  const receipt = { id: requestId, at: now, source: 'manual-state-adjustment', patch: { ...patch }, before, after, noticeable, sensation, aware };
  s.bodyAdjustments = [...(s.bodyAdjustments || []), receipt].slice(-64);
  s.adjustmentRevision = (s.adjustmentRevision || 0) + 1;
  if (noticeable) {
    s.memories.unshift({ ts: now, text: '身体出现了一阵起因未知的变化：' + sensation });
    s.memories = s.memories.slice(0, 32);
  }
  reconcileHumanity(s);
  return { ok: true, changed: Object.keys(after).length > 0, noticeable, sensation, aware, state: describeHumanity(s, now) };
}

export function createHumanityStore(file, clock = Date.now) {
  let loaded = false, pets = {}, lastSave = 0;
  const load = () => {
    if (loaded) return;
    if (humanFs.existsSync(file)) {
      const data = JSON.parse(humanFs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !data.pets || typeof data.pets !== 'object' || Array.isArray(data.pets)) throw new Error('身心状态文件格式不正确：' + file);
      pets = Object.assign(Object.create(null), data.pets);
      for (const [id, s] of Object.entries(pets)) {
        if (!s || !s.stats || !s.emotions || Array.isArray(s.stats) || Array.isArray(s.emotions) || !Number.isFinite(s.updatedAt)) throw new Error('身心状态条目损坏：' + id);
        validateResponses(s);
        if ((s.adjustmentRevision !== undefined && (!Number.isSafeInteger(s.adjustmentRevision) || s.adjustmentRevision < 0)) ||
          (s.bodyAdjustments !== undefined && (!Array.isArray(s.bodyAdjustments) || s.bodyAdjustments.length > 64 || s.bodyAdjustments.some(c =>
            !c || typeof c.id !== 'string' || !Number.isFinite(c.at) || c.at > s.updatedAt || typeof c.sensation !== 'string' ||
            typeof c.noticeable !== 'boolean' || typeof c.aware !== 'boolean' || c.source !== 'manual-state-adjustment' ||
            !c.patch || typeof c.patch !== 'object' || Array.isArray(c.patch) || Object.entries(c.patch).some(([k, v]) => !Object.hasOwn(HUMAN_STATS, k) || !Number.isFinite(v) || v < 0 || v > 100)))))
          throw new Error('身体干预记录损坏：' + id);
        const initial = createHumanity(clock());
        for (const key of Object.keys(initial.stats)) s.stats[key] = humanClamp(Number.isFinite(s.stats[key]) ? s.stats[key] : initial.stats[key]);
        for (const key of Object.keys(initial.emotions)) s.emotions[key] = humanClamp(Number.isFinite(s.emotions[key]) ? s.emotions[key] : initial.emotions[key]);
        s.cooldowns = s.cooldowns && typeof s.cooldowns === 'object' ? s.cooldowns : {};
        s.memories = Array.isArray(s.memories) ? s.memories.filter(m => m && Number.isFinite(m.ts) && m.ts > 0 && typeof m.text === 'string').slice(0, 32).map(m => ({ ts: m.ts, text: m.text.slice(0, 200) })) : [];
        if (!Number.isFinite(s.lastInteraction)) s.lastInteraction = clock();
        if (!Number.isFinite(s.lastFedAt)) s.lastFedAt = s.cooldowns.feed ? s.cooldowns.feed - 60000 : s.updatedAt;
        // The host's SleepStore is process-local: settle offline rest, then release its old sleep latch.
        pets[id] = advanceHumanity(s, clock());
        pets[id].sleeping = false;
      }
    } else pets = Object.create(null);
    loaded = true;
  };
  const save = () => {
    humanFs.mkdirSync(humanPath.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    try { humanFs.writeFileSync(temp, JSON.stringify({ version: 1, pets }, null, 2), 'utf8'); humanFs.renameSync(temp, file); lastSave = clock(); }
    finally { if (humanFs.existsSync(temp)) humanFs.unlinkSync(temp); }
  };
  const get = (id) => {
    if (typeof id !== 'string' || !id || id.length > 64 || id === '.' || id === '..' || /[\\/:\x00-\x1f]/.test(id)) throw new Error('无效宠物标识');
    load(); const fresh = !Object.hasOwn(pets, id);
    const previous = fresh ? createHumanity(clock()) : pets[id];
    const now = clock(), next = advanceHumanity(previous, now);
    const wallet = globalThis[Symbol.for('dsh.pet.companion.v1')]?.store?.read(id)?.wallet;
    const walletPainChanged = wallet?.balance === 0 && next.stats.pain !== 100;
    if (wallet?.balance === 0) next.stats.pain = 100;
    pets[id] = next;
    if (fresh || walletPainChanged || clock() - lastSave >= 60000) save();
    return structuredClone(next);
  };
  return { get, snapshot: (id) => { const state = get(id); return describeHumanity(state, clock()); },
    exertLabor(id, requestId, seconds, intensity=1) {
      if(typeof requestId!=='string'||!/^labor-effort:[a-zA-Z0-9:-]{8,140}$/.test(requestId)||!Number.isFinite(seconds)||seconds<0||seconds>30||!Number.isFinite(intensity)||intensity<1||intensity>1.7)throw new Error('搬运消耗回执无效');
      const prior=get(id),previous=prior.serviceActions?.[requestId];if(previous)return {...previous,duplicate:true};
      const next=structuredClone(prior),effort=seconds*intensity;
      next.stats.stamina=humanClamp(next.stats.stamina-effort*.08);
      next.stats.energy=humanClamp(next.stats.energy-effort*.045);
      next.stats.satiety=humanClamp(next.stats.satiety-effort*.015);
      const receipt={ok:true,at:clock(),action:'labor-effort',seconds,intensity};
      next.serviceActions={...prior.serviceActions,[requestId]:receipt};pets[id]=next;
      try{save();}catch(e){pets[id]=prior;throw e;}return receipt;
    },
    serviceAct(id, action, requestId) {
      if (!['feed', 'explore'].includes(action) || typeof requestId !== 'string' || !/^[a-zA-Z0-9:-]{8,140}$/.test(requestId)) throw new Error('生活服务回执无效');
      const prior = get(id), previous = prior.serviceActions?.[requestId];
      if (previous) return { ...previous, duplicate: true };
      const result = actHumanity(prior, action, clock());
      // Persist successful effects and their idempotency receipt in one write.
      if (result.ok) {
        const next = result.state;
        next.serviceActions = { ...prior.serviceActions, [requestId]: { ok: true, at: clock(), action } };
        pets[id] = next;
        try { save(); } catch (e) { pets[id] = prior; throw e; }
      }
      return { ok: result.ok, message: result.message, state: result.state };
    },
    adjust(id, patch, requestId, expectedRevision) {
      const prior = get(id), result = adjustHumanity(prior, patch, requestId, expectedRevision, clock());
      if (result.ok && !result.duplicate) {
        pets[id] = result.state;
        try { save(); } catch (e) { pets[id] = prior; throw e; }
      }
      return result;
    },
    painThought(id, collisionAt, interactionAt, thought, cryingUntil) {
      const current = get(id);
      if (current.collision?.at !== collisionAt || current.lastInteraction !== interactionAt || current.cryingUntil !== cryingUntil) return null;
      const next = structuredClone(current); next.lastThought = thought;
      pets[id] = next; try { save(); } catch (e) { pets[id] = current; throw e; }
      return describeHumanity(next, clock());
    },
    act(id, action) { const prior = get(id), result = actHumanity(prior, action, clock()); if (result.ok) { pets[id] = result.state; try { save(); } catch (e) { pets[id] = prior; throw e; } } return result; },
    react(id, event, detail) { const current = get(id); const next = reactHumanity(current, event, clock(), detail); if (JSON.stringify(current) !== JSON.stringify(next)) { pets[id] = next; try { save(); } catch (e) { pets[id] = current; throw e; } } return next; },
    prompt(id) { return humanityPrompt(get(id), clock()); } };
}

let humanStore;
export function getHumanityStore() {
  if (!humanStore) humanStore = createHumanityStore(humanPath.join(process.env.DSH_HOME || humanPath.join(humanOs.homedir(), '.dsh'), 'dsh-pet', 'humanity.json'));
  return humanStore;
}
export function safeHumanityPrompt(id) {
  try { return getHumanityStore().prompt(id) + (globalThis[Symbol.for('dsh.pet.companion.v1')]?.prompt(id) || ''); }
  catch (e) { console.error('[dsh-pet] 身心状态读取失败', e.message); return ''; }
}
export function observeHumanity(id, leaf, data) {
  const allow = globalThis[Symbol.for('dsh.pet.companion.v1')]?.observe(id, leaf, data);
  try { if (leaf === 'sleep') getHumanityStore().react(id, data?.sleeping ? 'sleep' : 'wake'); }
  catch (e) { console.error('[dsh-pet] 身心状态更新失败', e.message); }
  return allow !== false;
}
export function chatHumanity(id, text) {
  try { getHumanityStore().react(id, 'chat', text); }
  catch (e) { console.error('[dsh-pet] 身心状态更新失败', e.message); }
}

export async function handleHumanityRoute(deps, input, readConfig, packageRoot) {
  const { rest, method, url, body } = input;
  const companion = globalThis[Symbol.for('dsh.pet.companion.v1')];
  if (companion && rest.startsWith('humanity')) {
    const who = deps.requirePet(url.searchParams, readConfig);
    if (who.ok) {
      const petId = who.petId;
      companion.bind(petId, { ...deps, humanityStore: getHumanityStore(), humanity: () => getHumanityStore().snapshot(petId) });
      companion.imported ||= new Set();
      if (!companion.imported.has(petId)) { companion.import(petId, humanPath.dirname(deps.userRoot)); companion.imported.add(petId); }
      const result = await companion.route({ ...deps, readConfig, humanityStore: getHumanityStore() }, input);
      if (result) return result;
    }
  }
  if (!['humanity', 'humanity/state', 'humanity/care', 'humanity/adjust', 'humanity/style.css', 'humanity/panel.js', 'humanity/companion.js', 'humanity/portrait.png', 'humanity/cry.png', 'humanity/sulk-coax.png', 'humanity/sulk-blanket.png', 'humanity/sulk-bowl.png', 'humanity/labor-lift.png', 'humanity/labor-carry.png', 'humanity/phone.png', 'humanity/curled.png', 'humanity/curled.png', 'humanity/bowl.png', 'humanity/basin.png', 'humanity/begging.png'].includes(rest)) return undefined;
  const json = (obj, status = 200) => ({ kind: 'json', status, obj, headers: { 'cache-control': 'no-store' } });
  if (!['humanity/state', 'humanity/care', 'humanity/adjust'].includes(rest)) {
    if (method !== 'GET') return json({ ok: false, message: '请使用 GET' }, 405);
    const files = { humanity: ['humanity.html', 'text/html; charset=utf-8'], 'humanity/style.css': ['humanity.css', 'text/css; charset=utf-8'],
      'humanity/panel.js': ['humanity-panel.js', 'text/javascript; charset=utf-8'], 'humanity/companion.js': ['companion-panel.js', 'text/javascript; charset=utf-8'], 'humanity/portrait.png': ['main-character.png', 'image/png'], 'humanity/cry.png': ['humanity-cry.png', 'image/png'], 'humanity/sulk-coax.png': ['sulk-coax.png', 'image/png'], 'humanity/sulk-blanket.png': ['sulk-blanket.png', 'image/png'], 'humanity/sulk-bowl.png': ['sulk-bowl.png', 'image/png'], 'humanity/labor-lift.png': ['labor-lift.png', 'image/png'], 'humanity/labor-carry.png': ['labor-carry.png', 'image/png'], 'humanity/phone.png': ['body-phone.png', 'image/png'], 'humanity/curled.png': ['body-curled.png', 'image/png'], 'humanity/curled.png': ['body-curled.png', 'image/png'], 'humanity/bowl.png': ['rice-bowl.png', 'image/png'], 'humanity/basin.png': ['rice-basin.png', 'image/png'], 'humanity/begging.png': ['rice-begging.png', 'image/png'] };
    const [file, contentType] = files[rest]; return { kind: 'file', file: humanPath.join(packageRoot, 'assets', file), contentType };
  }
  if (method !== (rest === 'humanity/state' ? 'GET' : 'POST')) return json({ ok: false, message: '请求方法不正确' }, 405);
  try {
    const who = deps.requirePet(url.searchParams, readConfig);
    if (!who.ok) return who.res;
    const store = getHumanityStore(), petId = who.petId;
    if (method === 'GET') return json({ ok: true, name: String(who.pet.name || petId), state: store.snapshot(petId) });
    let o; try { o = JSON.parse(body || '{}'); } catch { return json({ ok: false, reason: 'invalid-json', message: '请求格式不正确' }, 400); }
    if (rest === 'humanity/adjust') {
      const blocked = deps.lockBlocked(petId, url.searchParams); if (blocked) return blocked;
      const result = store.adjust(petId, o?.stats, o?.requestId, o?.expectedRevision);
      if (!result.ok) return json(result, result.reason === 'conflict' ? 409 : 400);
      if (result.noticeable && !result.duplicate) {
        companion?.safe(() => companion.store.record(petId, 'body-change', '身体出现起因未知的变化：' + result.sensation, 'body-change:' + o.requestId));
        if (result.aware && !result.state.resting && companion?.lifeNotice) {
          companion.safe(() => companion.lifeNotice(petId, suddenBodyPrompt(result.state)));
          result.reaction = { queued: true };
        } else result.reaction = { queued: false, message: result.state.resting ? '她正在休息，醒后会察觉身体的不同' : '聊天服务尚未就绪，重新打开 DeepSeek 后可在聊天中感受到变化' };
      }
      return json(result);
    }
    if (!o || typeof o !== 'object' || typeof o.action !== 'string') return json({ ok: false, reason: 'bad-request', message: '请指定照料方式' }, 400);
    const blocked = deps.lockBlocked(petId, url.searchParams); if (blocked) return blocked;
    if (o.action === 'knock' || o.action === 'utensil') {
      if (o.action === 'knock' && (!Number.isInteger(o.count) || o.count < 3 || o.count > 8)) return json({ ok: false, message: '连点次数无效' }, 400);
      if (o.action === 'utensil' && (!['bowl','basin'].includes(o.kind) || !Number.isFinite(o.speed) || o.speed < 0 || o.speed > 10000 || (o.origin !== undefined && !['user-drag','user-throw','unknown'].includes(o.origin)))) return json({ ok: false, message: '道具碰撞无效' }, 400);
      const before = store.get(petId), next = store.react(petId, o.action, o);
      if ((next.cooldowns['event-' + o.action] || 0) > (before.cooldowns['event-' + o.action] || 0)) {
        companion?.safe(() => companion.care(petId, o.action, next.memories[0]?.text || next.lastThought, next.memories[0]?.ts));
        if (!deps.sleep.sleeping(petId)) deps.state.writePet(petId, 'say', { text: next.lastThought, duration: 7000, anim: false, humanity: describeHumanity(next) });
      }
      return json({ ok: true, state: describeHumanity(next) });
    }
    if (o.action === 'collision') {
      if (!['left', 'right', 'ceiling', 'floor'].includes(o.edge) || !Number.isFinite(o.speed) || o.speed < 0 || o.speed > 1000000 || (o.origin !== undefined && !['user-throw','unknown'].includes(o.origin))) return json({ ok: false, message: '碰撞数据无效' }, 400);
      const before = store.get(petId), next = store.react(petId, 'collision', { edge: o.edge, speed: o.speed, origin: o.origin || 'unknown' });
      if ((next.cooldowns['event-collision'] || 0) > (before.cooldowns['event-collision'] || 0) && !deps.sleep.sleeping(petId)) {
        deps.state.writePet(petId, 'say', { text: next.lastThought, duration: 6500, anim: false, humanity: describeHumanity(next) });
        companion?.safe(() => companion.care(petId, 'collision', next.memories[0]?.text || next.lastThought, next.memories[0]?.ts));
      }
      return json({ ok: true, state: describeHumanity(next) });
    }
    if (o.action === 'impact') {
      if (!Number.isFinite(o.strength) || o.strength < 0 || o.strength > 2) return json({ ok: false, message: '力度无效' }, 400);
      const before = store.get(petId), next = store.react(petId, 'impact', o.strength);
      if ((next.cooldowns['event-impact'] || 0) > (before.cooldowns['event-impact'] || 0) && !deps.sleep.sleeping(petId)) {
        deps.state.writePet(petId, 'say', { text: next.lastThought, duration: 6000, anim: false });
      }
      return json({ ok: true, state: describeHumanity(next) });
    }
    const result = store.act(petId, o.action);
    if (result.ok) {
      companion?.safe(() => companion.care(petId, o.action, result.state.memories[0]?.text || o.action, result.state.memories[0]?.ts));
      if (o.action === 'wake') deps.sleep.wake(petId);
      const eating = o.action === 'feed' ? who.conf?.animations?.baifan?.[3] : undefined;
      if (typeof eating === 'string' && eating) {
        const record = deps.playback.create(petId, eating);
        deps.state.writePet(petId, 'anim', { name: eating, playbackId: record.playbackId });
      }
      if (companion?.reactToEvent) {
        try { result.text = await companion.reactToEvent(petId, '爸爸进行了照料：' + (result.state.memories[0]?.text || o.action) + '；身体当前状态：' + JSON.stringify(result.state.stats)); result.reaction = { ok: true }; }
        catch (e) { result.text = ''; result.reaction = { ok: false, message: e.message }; }
      } else { result.text = ''; result.reaction = { ok: false, message: '聊天服务尚未就绪，请重启 DeepSeek' }; }
    } else if (companion?.reactToEvent) {
      try { result.reaction = { ok: true, text: await companion.reactToEvent(petId, '爸爸尝试进行照料 ' + o.action + '，但没有成功：' + result.message) }; }
      catch (e) { result.reaction = { ok: false, message: e.message }; }
    }
    return json(result);
  } catch (e) { return json({ ok: false, reason: 'internal-error', message: '身心状态无法保存，请检查文件权限或备份：' + e.message }, 500); }
}
