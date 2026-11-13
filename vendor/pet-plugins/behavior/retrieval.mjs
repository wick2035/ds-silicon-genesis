// Local Chinese/English retrieval. No model calls or embedding service required.
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/爸爸|老爸|父亲/g, '爸').replace(/(陪|喂|哄|逗|抱|夸|惩罚)(?:我|你|她)/g, '$1小鱼')
  .replace(/白饭|米饭/g, '饭').replace(/手机|电话/g, '手机');
const stop = new Set(['什么','怎么','记得','记住','知道','可以','一下','那个','这个','我们','你们','爸爸']);
export function terms(value) {
  const out = [];
  for (const token of normalize(value).match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || []) {
    if (/^[a-z0-9_]+$/.test(token)) out.push(token);
    else if (token.length === 1) out.push(token);
    else for (let i = 0; i < token.length - 1; i++) if (!stop.has(token.slice(i, i + 2))) out.push(token.slice(i, i + 2));
  }
  return out;
}
export function sourceValidator(p) {
  const eventIds = new Set(p.events.map(e=>e.id));
  const all = [...p.events, ...p.facts, ...p.growth.memories, ...p.growth.strategies, ...(p.growth.skills||[])];
  const byId = new Map(all.map(item => [item.id, item]));
  const blocked = new Set(p.growth.blocked);
  const memo = new Map();
  const valid = (item, visiting = new Set()) => {
    if (!item || item.deleted || blocked.has(item.id) || blocked.has(item.key)) return false;
    if (eventIds.has(item.id)) return true;
    if (memo.has(item.id)) return memo.get(item.id);
    if (visiting.has(item.id)) return false;
    const next = new Set(visiting).add(item.id);
    const ok = !item.sources?.length || item.sources.every(id => valid(byId.get(id), next));
    memo.set(item.id, ok); return ok;
  };
  return item => valid(item);
}
export function retrieve(p, query, now, {limit = 6, budget = 1000} = {}) {
  const q = new Set(terms(query)); if (!q.size) return [];
  const valid = sourceValidator(p);
  const docs = [...p.facts, ...p.growth.memories].filter(valid)
    .map((item, order) => ({...item, order, tokens: terms(item.text)}));
  const average = docs.reduce((n, d) => n + d.tokens.length, 0) / (docs.length || 1);
  const df = new Map([...q].map(t => [t, docs.filter(d => d.tokens.includes(t)).length]));
  const ranked = docs.map(d => {
    let score = 0, relevant = 0;
    for (const t of q) {
      const tf = d.tokens.filter(x => x === t).length; if (!tf) continue;
      relevant++;
      score += Math.log(1 + (docs.length - df.get(t) + .5) / (df.get(t) + .5)) * tf * 2.2 /
        (tf + 1.2 * (.25 + .75 * d.tokens.length / (average || 1)));
    }
    if (relevant) score *= 1 + (d.explicit || d.pinned ? .25 : 0) + (d.status === 'verified' ? .15 : 0)
      + .1 * Math.pow(.5, Math.max(0, now - d.ts) / (30 * 86400000));
    return {...d, text:excerpt(d,q,Math.min(600,budget)), score, relevant};
  }).filter(d => d.relevant).sort((a,b) => b.score-a.score || b.ts-a.ts || b.order-a.order);
  const chosen = []; let used = 0;
  while (ranked.length && chosen.length < limit) {
    const best = ranked.map(d => {
      const set = new Set(d.tokens);
      const similarity = Math.max(0, ...chosen.map(c => {
        const other = new Set(c.tokens), overlap = [...set].filter(t => other.has(t)).length;
        return overlap / Math.max(1, new Set([...set, ...other]).size);
      }));
      return {d, adjusted: d.score * (1 - .75 * similarity), similarity};
    }).sort((a,b) => b.adjusted-a.adjusted)[0];
    ranked.splice(ranked.indexOf(best.d), 1);
    if (best.similarity >= .88 || used + best.d.text.length > budget) continue;
    chosen.push(best.d); used += best.d.text.length;
  }
  return chosen.map(({tokens, ...item}) => item);
}

// Build a small evidence graph from persisted source links. It never turns
// lexical similarity into an asserted relationship and is rebuilt on demand,
// so deleted or invalidated evidence cannot survive in a separate cache.
export function cognitionContext(p, anchors, {limit=4, budget=800}={}) {
  const valid=sourceValidator(p);
  const nodes=[...p.facts, ...p.growth.memories].filter(valid);
  const roots=new Set(anchors.filter(valid).map(n=>n.id));
  const evidence=new Set(anchors.filter(valid).flatMap(n=>n.sources||[]));
  const related=[];
  for (const node of nodes) {
    if (roots.has(node.id) || !node.sources?.length) continue;
    const shared=node.sources.filter(id=>evidence.has(id) || roots.has(id));
    const referenced=anchors.filter(a=>(a.sources||[]).includes(node.id)).map(a=>a.id);
    if (!shared.length && !referenced.length) continue;
    related.push({id:node.id,text:String(node.text||'').slice(0,300),
      status:node.status||(node.explicit?'parent-stated':'recorded'),
      uncertainty:node.uncertainty||'',sources:node.sources,links:[...new Set([...shared,...referenced])]});
  }
  let used=0;
  return related.filter(n=>{const length=n.text.length;if (!length || used+length>budget) return false;used+=length;return true;}).slice(0,limit);
}

function excerpt(item,q,max) {
  if(item.text.length<=max)return item.text;
  const crop=(text,size)=>{
    if(text.length<=size)return text;
    let best=0,score=-1;
    for(let start=0;start<text.length;start+=Math.max(1,Math.floor(size/2))){
      const n=terms(text.slice(start,start+size)).filter(t=>q.has(t)).length;
      if(n>score){score=n;best=start;}
    }
    return (best?'…':'')+text.slice(best,best+size)+(best+size<text.length?'…':'');
  };
  if(item.episode){
    const messages=item.episode.messages.map((m,i)=>({m,i,score:terms(m.text).filter(t=>q.has(t)).length}))
      .sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,2).sort((a,b)=>a.i-b.i);
    const quote=messages.map(({m})=>`${m.speaker}〔${m.isDad?'爸爸':'群友'}${m.participant?':'+m.participant:''}〕说：${crop(m.text,150)}`).join('；');
    return `${item.text.slice(0,16)} 群聊节选：${quote}；我当时实际回复：${crop(item.episode.reply||'未记录发言',100)}`.slice(0,max);
  }
  return crop(item.text,max-2);
}

export function eligibleSkills(p) {
  const valid = sourceValidator(p);
  const groupIds=new Set(p.events.filter(e=>e.sourceIdentity || e.userText?.startsWith('【QQ 群聊来源资料】')).map(e=>e.id));
  const derived=new Map([...p.growth.memories,...p.facts].map(m=>[m.id,m]));
  const trusted=(id,visited=new Set())=>{
    if(groupIds.has(id)||visited.has(id))return false;
    const item=derived.get(id);return !item || item.sources.every(s=>trusted(s,new Set(visited).add(id)));
  };
  return p.growth.strategies.filter(s => valid(s) && s.sources?.length && s.sources.every(id=>trusted(id)));
}

export function skillEvidence(p, strategyId, kind, phase) {
  const valid=sourceValidator(p),evidence=new Set(p.events.filter(valid).map(e=>e.id));
  const attempts = p.growth.attempts.filter(a => !a.invalidated && a.strategyId === strategyId && a.kind === kind);
  const success = attempts.filter(a => a.status === 'succeeded' && evidence.has(a.outcomeSource)).length;
  const failed = attempts.filter(a => a.status === 'rejected').length;
  const local = attempts.filter(a => a.phase === phase);
  const localSuccess = local.filter(a => a.status === 'succeeded' && evidence.has(a.outcomeSource)).length;
  const localFailure = local.filter(a => a.status === 'rejected').length;
  return {success, failed, trials: success + failed,
    score: (1 + success + localSuccess * .5) / (2 + success + failed + (localSuccess + localFailure) * .5)
      + .12 / (1 + success + failed)};
}
