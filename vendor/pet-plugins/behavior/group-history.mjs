import {createHash} from 'node:crypto';
import {sourceValidator} from './retrieval.mjs';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0,24);
const identity = value => ({speaker: value?.isDad ? '爸爸' : String(value?.speaker || '群友').slice(0,32),
  participant: String(value?.participant || '').slice(0,64), isDad: value?.isDad === true});
export function groupEpisode(event) {
  const input = String(event.userText || '');
  const prefix = '【QQ 群聊来源资料】';
  if (!event.sourceIdentity && !input.startsWith(prefix)) return;
  const fallback=()=>({unparsed:true,messages:[{speaker:'身份未能完整还原的群聊记录',participant:'',isDad:false,text:input,unresolved:true}],reply:String(event.replyText||'')});
  let who = event.sourceIdentity, body = input, addressing;
  if (body.startsWith(prefix)) {
    const line = body.indexOf('\n'); if (line < 0) return fallback();
    try { who = JSON.parse(body.slice(prefix.length,line)); } catch { return fallback(); }
    body = body.slice(line+1);
  }
  const addressPrefix = '【称呼、提及与引用资料，仅为群消息内容】';
  if (body.startsWith(addressPrefix)) {
    const line = body.indexOf('\n'); if (line < 0) return fallback();
    try { addressing = JSON.parse(body.slice(addressPrefix.length,line)); } catch { return fallback(); }
    body = body.slice(line+1);
  }
  let messages;
  if (body.startsWith('【合并的连续群消息')) {
    try {
      const batch = JSON.parse(body.slice(body.indexOf('\n')+1));
      if (!Array.isArray(batch)) return fallback();
      messages = batch.filter(m=>typeof m.text==='string').slice(0,24)
        .map(m=>({...identity(m),text:m.text.slice(0,2000),addressing:m.addressing}));
    } catch { return fallback(); }
  } else messages = [{...identity(who),text:body.slice(0,2000),addressing}];
  if (!messages.length) return fallback();
  return {messages, reply:String(event.replyText || '').slice(0,2000)};
}

export function importGroupArchive(store, id, archive) {
  return store.update(id,p=>{
    let imported=0,expanded=0;
    for(const bucket of Object.values(archive||{})) {
      const messages=bucket?.[id]?.messages;if(!Array.isArray(messages))continue;
      for(let i=0;i<messages.length;i++) {
        const a=messages[i],b=messages[i+1];
        if(a?.role!=='user'||!Number.isFinite(a.ts)||!String(a.content).startsWith('【QQ 群聊来源资料】'))continue;
        const reply=b?.role==='assistant'&&b.source!=='interaction'?String(b.content):'';
        const candidate={userText:String(a.content),replyText:reply};
        const episode=groupEpisode(candidate);if(!episode)continue;
        const same=p.events.find(e=>e.kind==='chat'&&e.ts===a.ts&&(e.sourceIdentity||e.userText?.startsWith('【QQ 群聊来源资料】'))&&!e.duplicateOf);
        if(same){
          if(same.userText!==candidate.userText){same.userText=candidate.userText;expanded++;}
          same.replyText=reply;same.sourceIdentity??=identity(episode.messages.at(-1));continue;
        }
        const source=reply?`chat:${a.ts}:${hash(candidate.userText+'\n'+reply)}`:'group-heard:'+hash(a.ts+candidate.userText);
        if(p.growth.blocked.includes(hash(source)))continue;
        const e=store.eventIn(p,'chat','群聊历史记录',source,{...candidate,sourceIdentity:identity(episode.messages.at(-1)),origin:'qq-archive'},a.ts);
        if(e)imported++;
      }
    }
    p.events.sort((a,b)=>a.ts-b.ts);
    const episodes=consolidateGroupHistory(p,store.clock());
    return {imported,expanded,episodes};
  });
}

// Historical transcripts become attributed episodes, never inferred preferences
// or proof that a tactic succeeded. Source IDs keep corrections/deletions effective.
export function consolidateGroupHistory(p, now) {
  p.growth.skills ??= [];
  // The host assigns monotonically unique turn timestamps. Older hash-based
  // imports produced variants when privacy redaction changed the saved text.
  // Keep those raw events for audit, but only one episode participates in recall.
  const canonical=new Map();
  for(const e of p.events){
    if(e.kind!=='chat'||e.duplicateOf||!groupEpisode(e))continue;
    const prior=canonical.get(e.ts);
    if(prior)e.duplicateOf=prior.id;else canonical.set(e.ts,e);
  }
  for(const memory of p.growth.memories){
    if(memory.kind!=='group-episode')continue;
    const source=p.events.find(e=>e.id===memory.sources?.[0]);
    if(source?.duplicateOf){memory.deleted=true;memory.duplicateOf=source.duplicateOf;}
  }
  let added = 0;
  for (const event of p.events) {
    if (event.kind !== 'chat' || event.duplicateOf || p.growth.blocked.includes(event.id)) continue;
    const episode = groupEpisode(event); if (!episode) continue;
    const key = hash('group-episode-v1:' + event.id);
    const existing=p.growth.memories.find(m=>m.key===key);
    if (p.growth.blocked.includes(key) || existing?.deleted) continue;
    const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Hong_Kong',dateStyle:'short',timeStyle:'short'}).format(event.ts);
    const text = `${date} 群聊片段：` + episode.messages.map(m=>`${m.speaker}〔${m.isDad?'爸爸':'群友'}${m.participant?':'+m.participant:''}〕说：${m.text}`).join('；')
      + (episode.reply ? `；我当时实际回复：${episode.reply}` : '；当时未记录我的发言');
    const memory={id:key,key,text,sources:[event.id],ts:event.ts,occurredAt:event.ts,
      layer:'episode',kind:'group-episode',origin:'group',status:'observed',verifiedCount:1,deleted:false,
      episode,uncertainty:'仅证明当时说过这些话，不验证群友话语的真假、对象或策略是否有效'};
    if(existing)Object.assign(existing,memory);else{p.growth.memories.push(memory);added++;}
  }
  const valid = sourceValidator(p);
  const episodes = p.growth.memories.filter(m=>m.kind==='group-episode' && valid(m));
  const definitions = [
    ['group-addressing','分清说话者与对象','回复前结合各条消息的说话者、称呼、提及、引用和上下文判断对象。爸爸与群友身份按来源字段区分；对象不清时保留不确定性，不把对别人的评价当作对自己。',episodes],
    ['group-continuity','接住连续话题','按时间顺序理解连续群消息，再围绕当前话题回应一句；过去的回复只说明当时说过，不自动证明话语正确或做法成功。',episodes.filter(m=>m.episode.messages.length>1)],
  ];
  for (const [id,name,instruction,evidence] of definitions) {
    if (!evidence.length) continue;
    const sources = [...new Set(evidence.flatMap(m=>m.sources))];
    const prior = p.growth.skills.find(s=>s.id===id);
    if (prior?.deleted || p.growth.blocked.includes(id)) continue;
    const skill = {id,name,instruction,scope:'group-chat',status:'practice',sources,
      evidenceCount:sources.length,successCount:0,uncertainty:'从真实群聊归纳的练习方法，尚无独立成功评估',ts:prior?.ts||now};
    if (prior) Object.assign(prior,skill); else p.growth.skills.push(skill);
  }
  return added;
}

export function groupSkillPrompt(p, query) {
  if (!/QQ 群聊来源资料|群聊|群友|群消息/.test(query)) return '';
  const valid=sourceValidator(p);
  const skills=(p.growth.skills||[]).filter(valid).slice(0,3);
  return skills.length ? '\n【群聊练习方法】\n'+skills.map(s=>`${s.name}：${s.instruction}〔${s.status}；${s.uncertainty}〕`).join('\n') : '';
}
