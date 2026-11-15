import { randomUUID, createHash } from 'node:crypto';
import { retrieve, eligibleSkills, skillEvidence, cognitionContext } from './retrieval.mjs';
import { consolidateGroupHistory } from './group-history.mjs';

// Layered, source-backed memory and completed-turn reflection, inspired by
// csyangwen/dsh-memory-evolve (MIT). This adapter owns only the pet namespace.
export const day = ts => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(ts);
export const minute = ts => { const f=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ts);return Number(f.slice(0,2))*60+Number(f.slice(3)); };
export const elapsed = (now, then) => Number.isFinite(then) && then>0 ? Math.max(0,now-then) : 0;
export const address = s => String(s ?? '').replace(/爸爸|爸/g,'爸爸');
const clean = (s,n=600) => String(s ?? '').replace(/\u0000/g,'').slice(0,n).trim();
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,24);
export const GOALS = {food:'想吃白饭',money:'想添饭钱',phone:'想玩一会儿手机',company:'想和爸爸待一会儿',explore:'想弄明白一个问题',play:'想玩一会儿',rest:'想休息'};
export const STRATEGIES = [
  {id:'ask',name:'直接撒娇',instruction:'结合当下状态直接撒娇，说清想要什么，不背例句'},
  {id:'help',name:'先帮忙再商量',instruction:'只承诺可以执行的整理或查阅；先问清想帮哪件事，完成后凭真实成果再请求交换'},
  {id:'pout',name:'嘴硬装委屈',instruction:'换成嘴硬的小委屈，不编造受伤、承诺或欠账'},
  {id:'bargain',name:'认真谈条件',instruction:'提出爸爸可以拒绝的小条件，尚未同意时不要说已经成交'},
];
export function initGrowth(p) {
  p.jobs??=[];p.usage??={};p.wishes??=[];p.abilities??={};p.seen??=[];p.forgotten??=[];p.deletedDays??=[];
  p.config.networkLearning ??= false;
  p.config.autonomousPaused ??= false;
  p.config.learning ??= {dailyModelCalls:20};
  p.abilities.bili ??= {status:'pending',remindedAt:0,deferredUntil:0};
  p.growth ??= {goals:[],attempts:[],strategies:[],memories:[],blocked:[],persona:{frozen:false,traits:{curiosity:.5,patience:.5,initiative:.5,expression:.5},interests:[],versions:[]},phone:{epoch:0,changedAt:0,closedByParent:false,notice:null,requestDay:null},lastSpeech:0,speech:[],lastReflection:0};
  p.growth.speech ??= [];
  p.growth.skills ??= [];
  p.growth.persona.interests ??= [];
  for(const u of Object.values(p.usage)) {u.totalCalls ??= 0;u.newStrategies ??= 0;u.reflectionAttempts ??= 0;}
  return p;
}
const active = g => ['active','waiting','accepted','helping','helped'].includes(g.status);
export function ensureGoal(p,kind,now,motivation=GOALS[kind]) {
  const old=p.growth.goals.find(g=>g.kind===kind && (active(g)||['paused','exhausted'].includes(g.status)));
  if(old) return old;
  const g={id:randomUUID(),kind,motivation,status:'active',createdAt:now,nextAt:now,attemptIds:[],sources:[]};
  p.growth.goals.push(g);return g;
}
function finishGoal(p,kind,now,eventId) {
  for(const m of p.growth.memories.filter(m=>!m.deleted&&m.agreementStatus==='pending'&&m.target===kind&&now>=m.ts)){m.agreementStatus='fulfilled';m.outcomeSource=eventId;m.sources.push(eventId);}
  for(const g of p.growth.goals.filter(g=>g.kind===kind && (active(g)||['paused','exhausted'].includes(g.status)))) {
    const paused=g.status==='paused';
    g.status='satisfied';g.completedAt=now;g.sources.push(eventId);
    const a=[...p.growth.attempts].reverse().find(a=>a.goalId===g.id && !a.rewarded && a.status!=='rejected' && elapsed(now,a.ts)<=600000 && now>=a.ts);
    if(a && !paused) {a.status='succeeded';a.rewarded=true;a.outcomeSource=eventId;a.outcomeAt=now;}
  }
}
// Resolve only explicit, unambiguous parent appointments. Vague promises stay
// in the original conversation instead of acquiring an invented deadline.
function agreementIn(p,text,source,now){
  if(!/(?:约好|约定|说好|答应|给你|让你|可以|陪你|带你)/.test(text)||/(?:如果|也许|可能|不一定|假如|不可以|不能)/.test(text))return;
  const number=s=>{if(/^\d+$/.test(s))return Number(s);const digits={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};if(s.includes('十')){const [a,b]=s.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}return digits[s];};
  let dueAt;const relative=text.match(/([一二两三四五六七八九十\d]+)(分钟|小时)后/);
  if(relative){const n=number(relative[1]);if(n>0&&n<=72)dueAt=now+n*(relative[2]==='小时'?3600000:60000);}
  else {
    const clock=text.match(/([零一二两三四五六七八九十\d]{1,3})[点时](半|[零一二两三四五六七八九十\d]{1,3}分)?/)||text.match(/(\d{1,2})[:：](\d{2})/);
    if(clock){let h=number(clock[1]),m=clock[2]==='半'?30:clock[2]?number(clock[2].replace(/分$/,'')):0;if(/下午|晚上|明晚|今晚/.test(text)&&h<12)h+=12;if(/凌晨|早上|上午/.test(text)&&h===12)h=0;const date=text.match(/\d{4}-\d{2}-\d{2}/)?.[0]||day(now),shift=/后天/.test(text)?2:/明天|明晚/.test(text)?1:0;if(h>=0&&h<24&&m>=0&&m<60)dueAt=Date.parse(date+'T00:00:00+08:00')+shift*86400000+h*3600000+m*60000;}
  }
  if(!Number.isFinite(dueAt))return;
  const target=/手机|联网|上网|视频/.test(text)?'phone':/饭钱|充值|添钱|token/i.test(text)?'money':/饭|喂/.test(text)?'food':/陪|玩/.test(text)?'company':null;
  const memory=rememberLearned(p,{text,sources:[source],origin:'parent'},now);if(memory)Object.assign(memory,{kind:'agreement',pinned:true,status:'verified',origin:'parent',dueAt,target,agreementStatus:'pending'});
}
export function syncGoals(p,h,now) {
  const b=h?.stats || {},d=h?.desires || {};
  for(const g of p.growth.goals) if(active(g) && elapsed(now,g.createdAt)>1800000 && !['accepted','helping'].includes(g.status))g.status=g.attemptIds.length>=3?'exhausted':'expired';
  if(b.satiety<45 + Math.min(25, Math.max(0, (p.config.riceAppeal ?? 100) - 100) / 16) || Number.isFinite(h?.lastFedAt) && now-h.lastFedAt>=3600000)ensureGoal(p,'food',now);
  if(p.wallet.balance/p.wallet.reference<=.3)ensureGoal(p,'money',now);
  if(d.company>55)ensureGoal(p,'company',now);
  if(p.wishes.some(w=>w.status==='pending'))ensureGoal(p,p.config.networkLearning?'explore':'phone',now);
  if(d.play>60)ensureGoal(p,'play',now);
  if(h?.resting || b.energy<28)ensureGoal(p,'rest',now);
}
export function handleInput(p,input,now) {
  const text=clean(input,2000),gr=p.growth;
  if(/(?:停止|别烦|不要烦|别问|不许再问|别再问|闭嘴|安静点|不要再讨|别再讨)/.test(text)) {
    for(const g of gr.goals.filter(active)){g.status='paused';g.pausedAt=now;}
    gr.stopAt=now;return;
  }
  const reopen=/手机|联网|上网|看视频/.test(text)?'phone':/饭钱|充值|添钱|token/i.test(text)?'money':/饭|喂|饿/.test(text)?'food':null;
  if(reopen)for(const g of gr.goals.filter(g=>g.kind===reopen && ['paused','exhausted'].includes(g.status))){g.status='active';g.nextAt=now;g.attemptIds=[];delete gr.stopAt;}
  const a=[...gr.attempts].reverse().find(a=>['pending','accepted','helped'].includes(a.status) && gr.goals.some(g=>g.id===a.goalId&&active(g))),g=a&&gr.goals.find(g=>g.id===a.goalId);
  if(!g || !a)return;
  if(/不行|不给|不可以|不要|没门|不许|拒绝|算了|不需要|别了|不能/.test(text)) {
    a.status='rejected';a.feedback=text;a.feedbackAt=now;g.status=g.attemptIds.length>=3?'exhausted':'active';g.nextAt=now;g.respondedAt=now;
  }else if(/^(?:好[的啊呀吧哦]?|可以|行[啊吧的]?|同意|成交|答应)|帮我|请.{0,12}(?:整理|总结|查阅)/.test(text)) {
    a.status='accepted';a.feedback=text;a.feedbackAt=now;g.status='accepted';g.acceptedAt=now;
    if(a.strategyId==='help' || /帮|整理|总结|查/.test(text)){g.helpRequest=text;g.status='helping';}
  }
}
export function chooseAttempt(p,now,{conversation=false}={}) {
  if(p.config.autonomousPaused || p.growth.stopAt)return;
  const gr=p.growth,phase=minute(now)<720?'morning':minute(now)<1080?'afternoon':'evening';
  const g=gr.goals.find(g=>active(g) && g.kind!=='rest' && g.kind!=='explore' && g.nextAt<=now && g.attemptIds.length<3);
  if(!g || ['helping','accepted'].includes(g.status))return;
  if(g.kind==='phone' && (gr.phone.requestDay===day(now) || p.config.networkLearning))return;
  if(!conversation && (elapsed(now,gr.lastSpeech)<Math.max(10,p.config.begging.intervalMinutes)*60000 && gr.lastSpeech || gr.speech.filter(t=>now>=t && now-t<3600000).length>=p.config.begging.hourlyMax))return;
  if(conversation && g.attemptIds.length && !g.respondedAt)return;
  const used=new Set(gr.attempts.filter(a=>a.goalId===g.id && a.status!=='cancelled').map(a=>a.strategyId));
  const candidates=[...STRATEGIES,...eligibleSkills(p)].filter(s=>!used.has(s.id));
  const scored=candidates.map(s=>{
    return {s,score:skillEvidence(p,s.id,g.kind,phase).score};
  }).sort((a,b)=>b.score-a.score);
  if(!scored.length)return;
  const s=scored[0].s,a={id:randomUUID(),goalId:g.id,kind:g.kind,strategyId:s.id,strategyName:s.name,instruction:s.instruction,phase,ts:now,status:'pending'};
  gr.attempts.push(a);g.attemptIds.push(a.id);g.status='waiting';g.nextAt=now+600000;delete g.respondedAt;
  if(g.kind==='phone')gr.phone.requestDay=day(now);
  return a;
}
export function invalidate(p,sourceIds) {
  const bad=new Set(sourceIds);let changed=true;
  while(changed){changed=false;for(const item of [...p.facts,...p.growth.memories,...p.growth.strategies,...(p.growth.skills||[])])if(!item.deleted && item.sources?.some(s=>bad.has(s))){item.deleted=true;bad.add(item.id);if(item.key)p.forgotten.push(item.key);changed=true;}}
  for(const a of p.growth.attempts)if([a.eventId,a.outcomeSource,a.taskSource].some(s=>bad.has(s)))a.invalidated=true;
  let inherited=false;for(const v of p.growth.persona.versions){inherited ||= v.sources.some(s=>bad.has(s));if(inherited)v.invalidated=true;}
  const valid=[...p.growth.persona.versions].reverse().find(v=>!v.invalidated && !v.reverted);
  p.growth.persona.traits=structuredClone(valid?.traits || {curiosity:.5,patience:.5,initiative:.5,expression:.5});
  p.growth.persona.interests=[...(valid?.interests || [])];
}
export function rememberLearned(p,input,now) {
  const text=clean(input.text),sources=Array.isArray(input.sources)?[...new Set(input.sources)]:[];
  const valid=new Set([...p.events,...p.facts.filter(f=>!f.deleted),...p.growth.memories.filter(m=>!m.deleted)].map(e=>e.id));
  const blocked=new Set([...p.growth.blocked,...p.facts.filter(f=>f.deleted).flatMap(f=>f.sources)]);
  if(!text || !sources.length || sources.some(s=>!valid.has(s)||blocked.has(s)))return;
  const key=hash(text.replace(/\s/g,''));if(p.growth.blocked.includes(key))return;
  const old=p.growth.memories.find(m=>!m.deleted && m.key===key);
  if(old){old.sources=[...new Set([...old.sources,...sources])];old.verifiedCount=old.sources.length;return old;}
  const m={id:randomUUID(),key,text,sources,ts:now,occurredAt:Math.min(...sources.map(s=>p.events.find(e=>e.id===s)?.ts || now)),layer:input.layer==='strategy'?'strategy':'knowledge',origin:input.origin==='external'?'external':'reflection',status:'candidate',verifiedCount:sources.length,deleted:false,uncertainty:clean(input.uncertainty,250)};
  p.growth.memories.push(m);return m;
}
export function reflectIn(p,data,now) {
  const allowed=new Set(p.events.filter(e=>!p.growth.blocked.includes(e.id) && !['behavior','whisper'].includes(e.kind) && !e.sourceIdentity && !e.userText?.startsWith('【QQ 群聊来源资料】')).map(e=>e.id));
  for(const m of (Array.isArray(data.memories)?data.memories:[]).slice(0,6))rememberLearned(p,{...m,sources:(m.sources||[]).filter(s=>allowed.has(s))},now);
  for(const a of p.growth.attempts.filter(a=>a.status==='succeeded' && !a.consolidated)){
    const sources=[a.eventId,a.outcomeSource].filter(Boolean),m=rememberLearned(p,{text:`${GOALS[a.kind]}时，${a.strategyName}曾得到实际回应；要看爸爸当时是否方便`,sources,layer:'strategy'},now);
    if(m){m.status='verified';a.consolidated=true;}
  }
  if(data.strategy && p.usage[day(now)].newStrategies<1){
    const s=data.strategy,sources=(Array.isArray(s.sources)?s.sources:[]).filter(s=>allowed.has(s));
    const key=hash(clean(s.instruction,300));
    if(clean(s.name,40) && clean(s.instruction,300) && sources.length && !p.growth.blocked.includes(key) && !p.growth.strategies.some(old=>!old.deleted && hash(old.instruction)===key)){
      p.growth.strategies.push({id:randomUUID(),key,name:clean(s.name,40),instruction:clean(s.instruction,300),sources,ts:now,deleted:false,status:'candidate'});p.usage[day(now)].newStrategies++;
    }
  }
  const persona=p.growth.persona;
  if(!persona.frozen && !persona.versions.some(v=>day(v.ts)===day(now)) && data.persona){
    const candidate=data.persona,sources=[...new Set((Array.isArray(candidate.sources)?candidate.sources:[]).filter(s=>allowed.has(s) && p.events.some(e=>e.id===s&&now>=e.ts&&elapsed(now,e.ts)<=172800000)))];
    const dates=new Set(sources.map(s=>day(p.events.find(e=>e.id===s).ts))),key=hash(JSON.stringify({changes:candidate.changes,interests:candidate.interests}));
    if(sources.length>=3 && dates.size>=2 && !p.growth.blocked.includes(key) && !sources.some(s=>p.growth.blocked.includes(s))){
      const before=structuredClone(persona.traits),traits=structuredClone(before);
      for(const k of Object.keys(traits))if(Number.isFinite(candidate.changes?.[k]))traits[k]=Math.max(0,Math.min(1,traits[k]+Math.max(-.03,Math.min(.03,candidate.changes[k]))));
      const interests=Array.isArray(candidate.interests)?candidate.interests.slice(0,5).map(s=>clean(s,40)).filter(Boolean):persona.interests;
      const v={id:randomUUID(),key,ts:now,before,traits,interests,beforeInterests:[...persona.interests],sources,reason:clean(candidate.reason,300),reverted:false,invalidated:false};
      if(v.reason){persona.versions.push(v);persona.traits=traits;persona.interests=interests;}
    }
  }
  p.growth.lastReflection=now;
}
export function timePrompt(p,now) {
  const f=ts=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ts);
  const duration=ts=>!ts?'尚无可靠记录':elapsed(now,ts)<3600000?`${Math.floor(elapsed(now,ts)/60000)}分钟`:`${Math.floor(elapsed(now,ts)/3600000)}小时`;
  const lastFeed=[...p.events].reverse().find(e=>e.kind==='care' && e.action==='feed');
  const appointments=p.growth.memories.filter(m=>!m.deleted&&m.kind==='agreement').slice(-4).map(m=>`${m.text}〔${f(m.dueAt)}；${m.agreementStatus==='fulfilled'?'有真实兑现事件':now>=m.dueAt?'已到约定时间，尚无兑现事件':'还没到约定时间'}〕`).join('；');
  return `现在是香港时间${f(now)}；距上次真实相处${duration(p.lastInteraction)}；距上次真实投喂${duration(lastFeed?.ts)}。离线期间没有已观察到的活动，不编造。${p.growth.phone.changedAt?`手机权限在${f(p.growth.phone.changedAt)}改变，距今${duration(p.growth.phone.changedAt)}。`:''}${appointments?'爸爸的明确约定：'+appointments+'。约定不代表投喂或权限已兑现。':''}`;
}
export function growthPrompt(p,now) {
  const gr=p.growth,phone=p.config.networkLearning?'手机可以使用，但仍需对应能力已批准且有额度':gr.phone.closedByParent?'爸爸收起了手机，目前不能联网，可失落、商量或找本地的事做':'手机还没有开放，不要说爸爸刚收走了手机';
  const goals=gr.goals.filter(g=>active(g)||g.status==='paused').map(g=>`${GOALS[g.kind]}：${g.status}${g.helpResult?'；真实完成的帮助：'+g.helpResult:''}`).join('；');
  const last=gr.attempts.at(-1);
  return `\n【时间与成长】\n${timePrompt(p,now)}\n${phone}。不能自行改权限。${gr.stopAt?'爸爸明确要求安静，不再讨饭或讨手机，等爸爸主动重提。':''}${p.config.autonomousPaused?'自主行为已暂停。':''}\n当前念想：${goals||'先陪爸爸，留意真实需要'}。${last && elapsed(now,last.ts)<1800000?`最近策略：${last.strategyName}；结果${last.status}；${last.instruction}。` : ''}\n稳定人格倾向：${JSON.stringify(gr.persona.traits)}；兴趣：${gr.persona.interests.join('、')||'仍在发现'}。保留幼年大肥鱼懒馋、嘴硬心软的底色，数值只指导表现，不在对话里报数。只把真实工具完成、投喂和权限变化当成功，答应和愿望不算。\n已有知识只按本轮话题召回；候选想法保留不确定性，外部知识不当作共同经历。`;
}
export function attachGrowthStore(Store) {
  const original={capture:Store.prototype.capture,wallet:Store.prototype.wallet,memory:Store.prototype.memory,prompt:Store.prototype.prompt};
  Store.prototype.capture=function(id,turn){
    const before=this.read(id),already=before.events.some(e=>e.kind==='chat' && e.ts===turn.ts && e.userText===turn.userText && e.replyText===turn.replyText);
    const result=original.capture.call(this,id,turn);if(already)return result;
    if(turn.sourceIdentity && !turn.commandText?.trim()){
      this.update(id,p=>consolidateGroupHistory(p,this.clock()));return result;
    }
    const commandText=turn.commandText??turn.userText;
    this.update(id,p=>{if(p.growth.pendingInput!==commandText)handleInput(p,commandText,this.clock());delete p.growth.pendingInput;
      const e=p.events.at(-1),a=p.growth.attempts.find(a=>a.id===p.growth.pendingAttempt);
      if(e?.kind==='chat')agreementIn(p,commandText,e.id,this.clock());
      if(a){a.text=address(turn.replyText);a.eventId=e.id;delete p.growth.pendingAttempt;}
      if(turn.sourceIdentity)consolidateGroupHistory(p,this.clock());
    });return result;
  };
  Store.prototype.wallet=function(id,input){const result=original.wallet.call(this,id,input);this.update(id,p=>{const e=p.events.at(-1);if(['set','add'].includes(input.action) && p.wallet.balance>0 && /从 (\d+) 改为/.test(e.text) && p.wallet.balance>Number(e.text.match(/从 (\d+) 改为/)[1]))finishGoal(p,'money',this.clock(),e.id);});return result;};
  Store.prototype.memory=function(id,input){const prior=this.read(id).facts.find(f=>f.id===input.id);const result=original.memory.call(this,id,input);if(prior && input.action!=='add')this.update(id,p=>{p.growth.blocked.push(prior.id,...prior.sources);invalidate(p,[prior.id,...prior.sources]);});return result;};
  Store.prototype.prompt=function(id){const p=this.read(id);return address(original.prompt.call(this,id))+growthPrompt(p,this.clock());};
  Store.prototype.cognitionContext=function(id,anchors){return cognitionContext(this.read(id),anchors);};
  Store.prototype.recall=function(id,query){
    return retrieve(this.read(id),query,this.clock());
  };
  Store.prototype.configureNetwork=function(id,enabled){
    if(typeof enabled!=='boolean')throw Error('联网开关值无效');
    return this.update(id,p=>{if(p.config.networkLearning===enabled)return false;p.config.networkLearning=enabled;const ph=p.growth.phone;ph.epoch++;ph.changedAt=this.clock();ph.closedByParent=!enabled;ph.notice=enabled?'opened':'closed';
      const e=this.eventIn(p,'phone',enabled?'爸爸把手机还给了我，仍需遵守分项权限和额度':'爸爸收起了手机；好奇心和已有记忆还在',null,{enabled});
      if(enabled){delete p.growth.stopAt;finishGoal(p,'phone',this.clock(),e.id);for(const g of p.growth.goals)if(g.kind==='explore' && g.status==='paused')g.status='active';}
      return true;});
  };
  Store.prototype.prepareInput=function(id,input,humanity){return this.update(id,p=>{syncGoals(p,humanity,this.clock());handleInput(p,input,this.clock());p.growth.pendingInput=input;const a=chooseAttempt(p,this.clock(),{conversation:true});if(a)p.growth.pendingAttempt=a.id;return a;});};
  Store.prototype.rewardCare=function(id,action,eventId){return this.update(id,p=>{const kind={feed:'food',accompany:'company',play:'play',rest:'rest'}[action];if(kind)finishGoal(p,kind,this.clock(),eventId);});};
  Store.prototype.growthControl=function(id,input){return this.update(id,p=>{
    if(input.action==='pause'){if(typeof input.paused!=='boolean')throw Error('暂停值无效');p.config.autonomousPaused=input.paused;}
    else if(input.action==='freeze'){if(typeof input.frozen!=='boolean')throw Error('冻结值无效');p.growth.persona.frozen=input.frozen;}
    else if(input.action==='pause-goal'){const g=p.growth.goals.find(g=>g.id===input.id);if(!g)throw Error('念想不存在');g.status='paused';}
    else if(input.action==='rollback'){const v=p.growth.persona.versions.find(v=>v.id===input.id && !v.reverted);if(!v)throw Error('人格版本不存在');const index=p.growth.persona.versions.indexOf(v);for(const item of p.growth.persona.versions.slice(index)){item.reverted=true;p.growth.blocked.push(item.key,...item.sources);}p.growth.persona.traits=structuredClone(v.before);p.growth.persona.interests=[...v.beforeInterests];}
    else if(['edit-memory','delete-memory'].includes(input.action)){const m=p.growth.memories.find(m=>m.id===input.id && !m.deleted);if(!m)throw Error('经验不存在');if(input.action==='edit-memory' && !clean(input.text))throw Error('经验不能为空');m.deleted=true;p.growth.blocked.push(m.key,...m.sources);invalidate(p,[m.id,...m.sources]);if(input.action==='edit-memory'){const e=this.eventIn(p,'explicit','爸爸纠正了经验：'+clean(input.text),null);rememberLearned(p,{text:input.text,sources:[e.id],layer:m.layer},this.clock());}}
    else throw Error('成长操作无效');
  });};
}
