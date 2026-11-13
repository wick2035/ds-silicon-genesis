import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { rememberLearned } from './growth.mjs';

// Every intention resolves to an existing full-body animation, never a meme.
export const BODY_ACTIONS = Object.freeze({
  eat: ['吃饭·碗饭', '吃完手里的一碗大白饭'],
  listen: ['东张西望', '认真听你说'], speak: ['悠闲哼歌', '在和你说话'],
  look: ['东张西望', '看看四周'], walk: ['螃蟹走路', '慢慢走过去'],
  approach: ['开心小跑', '向你靠近'], play: ['原地蹲下玩玩具汽车', '蹲下来玩一会儿'],
  learn: ['深度思考碎碎念', '琢磨刚才的发现'], remember: ['轻快记录', '把这件事记下来'],
  happy: ['点击回应-开心跃动', '忍不住高兴'], shy: ['点击回应-害羞惊讶', '有点害羞'],
  rest: ['原地小憩沉眠', '安静歇一会儿'], startle: ['被吓一跳', '吓了一跳'],
  pickup: ['原地重力下蹲压缩', '蹲下捡回饭钱'],
  beg: ['期待开饭', '捧着碗等开饭'],
  slack: ['原地蹲下玩玩具汽车', '蹲下来摸鱼玩一会儿'],
  tantrum: ['点击回应-傲娇生气', '抱碗坐地，软软地耍小脾气'],
  protest: ['工作状态-垂头叹气冒汗', '小声嘟囔，委屈地讲条件'],
  sulk_bowl: ['期待开饭', '抱碗坐地，抬眼委屈地等一口饭'],
  sulk_blanket: ['原地小憩沉眠', '裹住小毯子，露一只眼睛耍赖'],
  coax: ['点击回应-害羞惊讶', '伸手讨哄，偷偷高兴地靠近'],
  lift: ['原地重力下蹲压缩', '弯腰拿起这块砖'],
  putdown: ['原地重力下蹲压缩', '弯腰把砖放稳'],
});
const cut = (v, n = 240) => String(v ?? '').replace(/\u0000/g, '').slice(0, n);
const own = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
const placeNames = { here: '身边', left: '左边', right: '右边', center: '中间', edge: '屏幕边', home: '家里', outside: '桌面' };
function worldOf(p) { return p.world ||= { visits: [], questions: [], lastDecision: 0, command: null, error: null }; }
export function parseBodyReply(raw) {
  let plan;
  const text = String(raw).replace(/<body>([\s\S]*?)<\/body>/g, (_, json) => { try { plan ??= JSON.parse(json); } catch {} return ''; }).replace(/<body>[\s\S]*$/,'').trim();
  return { text, plan };
}
export function validateBodyPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 3) throw Error('身体计划需要一到三个动作');
  return { question: cut(plan.question, 100), steps: plan.steps.map(s => {
    if (!s || !own(BODY_ACTIONS, s.action)) throw Error('没有这种身体动作');
    const target = s.target ?? 'here'; if (!own(placeNames, target)) throw Error('不能去未经观察的地方');
    return { action: s.action, target };
  }) };
}
export function attachEmbodiment(Runtime) {
  const old = { route: Runtime.prototype.route, tick: Runtime.prototype.tick, prompt: Runtime.prototype.prompt, dispose: Runtime.prototype.dispose, startJob: Runtime.prototype.startJob, bind:Runtime.prototype.bind };
  Runtime.prototype.bind=function(id,deps){old.bind.call(this,id,deps);
    if(this.options.seedKnowledge && !this.knowledgeSeeded?.has(id)){
      this.knowledgeSeeded ||= new Set();
      const seeds=JSON.parse(fs.readFileSync(new URL('./knowledge-seeds.json',import.meta.url),'utf8'));
      this.store.update(id,p=>{for(const seed of seeds.entries.slice(0,12)){
        const key='external-seed:'+seed.id;if(p.seen.includes(key))continue;
        const e=this.store.eventIn(p,'knowledge','爸爸授权助手补充的外部知识：'+cut(seed.text,500),key,{sources:[{title:cut(seed.title),url:seed.url}],origin:'external',notSharedExperience:true});
        if(e)rememberLearned(p,{text:'外部知识：'+seed.text,sources:[e.id],origin:'external',layer:'knowledge',uncertainty:'来自资料的知识，不是我和爸爸共同经历的事情。来源：'+seed.url},this.store.clock());
      }});this.knowledgeSeeded.add(id);
    }
  };
  Runtime.prototype.bodySnapshot = function(id) {
    const p = this.store.read(id), w = worldOf(p), h = this.hosts.get(id)?.humanity?.();
    const c = w.command;
    // A process restart or vanished renderer cannot turn an old intention into a memory.
    if (c && ['queued','running'].includes(c.status) && (c.expires < this.store.clock() || c.epoch !== this.bodyEpoch)) {
      this.store.update(id, p => { const w=worldOf(p);w.command.status='interrupted';w.error='上一次动作没有完成，等身体准备好再来'; });
      return this.bodySnapshot(id);
    }
    const job=p.jobs.find(j=>['queued','running'].includes(j.status)&&j.kind==='explore');
    const wish=job&&p.wishes.find(x=>x.id===job.wishId||!job.wishId&&x.status==='pending');
    const phone=job&&wish&&wish.ability!=='image'&&p.config.networkLearning&&p.abilities[wish.ability]?.status==='granted';
    return { ...w, activity:phone?{kind:'phone',jobId:job.id,topic:wish.topic}:null, body: h?.body || { phase: 'well', mobility: 1, label: '自在活动' },
      sleeping: !!this.hosts.get(id)?.sleep?.sleeping(id) || !!h?.resting, space: p.space || null,
      paused: !!p.config.autonomousPaused || !!p.growth.stopAt, actions: BODY_ACTIONS };
  };
  Runtime.prototype.prompt = function(id) {
    const base = old.prompt.call(this,id), w=this.bodySnapshot(id);
    return base + '\n【身体与亲历】当前姿态：' + w.body.label + '。最近实际完成的动作：' + JSON.stringify(w.visits.slice(-6)) +
      '。尚在好奇：' + JSON.stringify(w.questions.slice(-4)) + '。行动计划不是已经做过；只能把带有完成回执的亲历当作事实。电脑是生活空间，但没读过的文件、网页和屏幕内容不能说已经看见。';
  };
  Runtime.prototype.issueBody = function(id, plan, source='chat') {
    plan=validateBodyPlan(plan); const h=this.hosts.get(id), w=this.bodySnapshot(id);
    // Retrieving escrow is deliberately possible while tired or curled up.
    // Actual sleep and user suspension still stop it; pain is never reset.
    if (source==='tokens' ? h?.sleep?.sleeping(id) || w.paused || this.tokensHeld(id) : w.sleeping) return null;
    if (!['tokens','labor'].includes(source) && w.body.mobility===0) { this.store.update(id,p=>{const c=worldOf(p).command;if(c&&['queued','running'].includes(c.status))c.status='interrupted';});return null; }
    const display=this.store.read(id).space?.mode;
    const surface=display==='outside' ? 'desktop' : 'web';
    if(plan.steps.some(s=>s.target==='outside') && surface!=='desktop')throw Error('现在只能在家里活动，尚未开放桌面');
    if(plan.steps.some(s=>s.target==='home') && surface==='desktop')throw Error('当前人在桌面；回家需要在显示位置中开放软件内活动');
    this.bodyEpoch ||= randomUUID();
    const command={id:randomUUID(),epoch:this.bodyEpoch,steps:plan.steps,source,surface,issued:this.store.clock(),expires:this.store.clock()+90000,status:'queued',index:0};
    this.store.update(id,p=>{const w=worldOf(p);w.command=command;w.error=null;if(plan.question && !w.questions.some(q=>q.text===plan.question)){w.questions.push({text:plan.question,ts:this.store.clock(),status:'wondering'});w.questions=w.questions.slice(-24);}});
    return command;
  };
  Runtime.prototype.beginBodyTurn = function(id) {
    this.bodyThinking ||= new Set();this.bodyThinking.add(id);
    this.bodyControllers?.get(id)?.abort();
    this.issueBody(id,{steps:[{action:'listen',target:'here'}]},'attention');
    return '\n【本轮身体协议，优先于旧版不写动作标记的要求】先认真回应爸爸的具体意思，可以自然说一到三句，不强制卖萌或讨饭。回复最后附一个隐藏的 <body>{"steps":[{"action":"动作","target":"位置"}],"question":"新的好奇问题，可为空"}</body>。动作可选 '+Object.keys(BODY_ACTIONS).join('、')+'；位置可选 '+Object.keys(placeNames).join('、')+'。最多三个连贯动作；不声称计划已完成，不写星号动作旁白；痛时保持保护姿势。不要用吃饭动作冒充实际投喂。';
  };
  Runtime.prototype.endBodyTurn = function(id, generated) {
    this.bodyThinking?.delete(id);
    if(!generated.ok){this.store.update(id,p=>{const w=worldOf(p);if(w.command)w.command.status='interrupted';w.error=cut(generated.message || '刚才没有听清，重试一下');});return;}
    const parsed=parseBodyReply(generated.text);generated.text=parsed.text;
    let plan;try{plan=validateBodyPlan(parsed.plan);}catch{plan={steps:[{action:'speak',target:'here'}],question:''};}
    try{this.issueBody(id,plan);}catch(e){this.store.update(id,p=>{worldOf(p).error=cut(e.message);});this.issueBody(id,{steps:[{action:'speak',target:'here'}]});}
  };
  Runtime.prototype.bodyReceipt = function(id,o) {
    const w=this.bodySnapshot(id), c=w.command;
    if(!c || c.id!==o.id || c.surface!==o.surface || c.index!==o.index || !['queued','running'].includes(c.status))throw Error('动作已改变，旧回执不再生效');
    if(w.sleeping || w.body.mobility===0) o={...o,status:'interrupted',reason:'身体还在恢复'};
    if(!['playing','completed','failed','interrupted'].includes(o.status))throw Error('回执状态无效');
    const step=c.steps[c.index], movement=['walk','approach'].includes(step.action);
    if(o.status==='completed' && (o.played!==true || movement && (!Number.isFinite(o.distance) || o.distance<2)))throw Error('身体尚未实际完成动作');
    this.store.update(id,p=>{const w=worldOf(p),c=w.command;
      if(o.status==='playing'){c.status='running';return;}
      if(o.status!=='completed'){c.status=o.status;w.error=cut(o.reason || '动作被打断了');return;}
      const visit={id:c.id+':'+c.index,action:step.action,place:placeNames[step.target],surface:c.surface,ts:this.store.clock()};
      // Attention and speech are visible reflexes, not discoveries or learned facts.
      if(!['listen','speak'].includes(step.action)){w.visits.push(visit);w.visits=w.visits.slice(-80);this.store.eventIn(p,'embodied','亲身完成：'+BODY_ACTIONS[step.action][1]+'；所在：'+visit.place+'；只确认动作和位置，不代表学到了外部知识',visit.id,{action:step.action,surface:c.surface});}
      c.index++;c.status=c.index<c.steps.length?'queued':'completed';
    });return this.bodySnapshot(id);
  };
  Runtime.prototype.bodyExplore = async function(id) {
    const p=this.store.read(id),w=this.bodySnapshot(id),now=this.store.clock();
    const outside=p.space?.mode==='outside';
    const observed=outside?p.space.outside:p.space?.mode==='home'?p.space.home:null;
    if(!observed)return;
    const busy=world=>world.paused||world.sleeping||world.body.mobility<1||world.activity||world.soft?.current||world.labor?.current?.status==='working'||this.bodyThinking?.has(id)||world.command&&['queued','running'].includes(world.command.status);
    if(!this.available(id)||busy(w)||now-p.lastInteraction<180000||[...this.active.keys()].some(k=>k.startsWith(id+':')))return;
    if(now-w.lastDecision<600000)return;
    this.bodyControllers ||= new Map();if(this.bodyControllers.has(id))return;
    const controller=new AbortController();this.bodyControllers.set(id,controller);
    const timeout=setTimeout(()=>controller.abort(),30000), interaction=p.lastInteraction, priorCommand=w.command?.id;
    const stillFree=()=>{const current=this.store.read(id),fresh=this.bodySnapshot(id);return !this.disposed&&!controller.signal.aborted&&this.available(id)&&!busy(fresh)&&current.space?.mode===p.space?.mode&&current.lastInteraction===interaction&&fresh.command?.id===priorCommand&&![...this.active.keys()].some(k=>k.startsWith(id+':'));};
    try{
      let plan, say='';
      {
        this.store.update(id,p=>{worldOf(p).lastDecision=now;});
        try{
          const raw=await this.model(id,'embody','你是幼年大肥鱼。自己决定接下来想做什么：可以走动、看看四周、玩玩具、休息，偶尔也可以主动找爸爸玩或聊点自己感兴趣的事，不必每次说话。只输出JSON：{"steps":[{"action":"walk","target":"left"}],"question":"好奇的问题，可为空","say":"想对爸爸说的话，可为空"}。最多三个动作。动作可选 '+Object.keys(BODY_ACTIONS).filter(a=>!['eat','lift','putdown','pickup'].includes(a)).join('、')+'；位置可选 here/left/right/center/edge。不要虚构看见屏幕内容或完成尚未发生的事，不要把想法说成爸爸的指令。',this.prompt(id),500,controller.signal);
          const choice=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
          plan=validateBodyPlan(choice);say=typeof choice.say==='string'?cut(choice.say.replace(/[\r\n]+/g,' '),100).trim():'';
          if(plan.steps.some(s=>['eat','lift','putdown','pickup'].includes(s.action)))throw Error('自主活动不能使用此动作');
        }catch(e){throw e;}
      }
      if(!stillFree())return;
      if(!plan)return;
      // The existing speech path turns this intention into a model-generated chat and body turn.
      if(say && this.publish(id,say,true))return;
      this.issueBody(id,plan,'curiosity');
    }catch(e){if(!controller.signal.aborted)this.store.update(id,p=>{worldOf(p).error=cut(e.message);});}
    finally{clearTimeout(timeout);if(this.bodyControllers.get(id)===controller)this.bodyControllers.delete(id);}
  };
  Runtime.prototype.tick=async function(){await old.tick.call(this);if(this.disposed)return;for(const id of this.hosts.keys())await this.bodyExplore(id);};
  Runtime.prototype.startJob=function(id,kind,input){
    const before=new Set(this.tasks||[]),jobId=old.startJob.call(this,id,kind,input);
    if(kind==='explore')this.store.update(id,p=>{const job=p.jobs.find(j=>j.id===jobId);if(job)job.wishId=input?.wishId||p.wishes.find(w=>w.status==='pending')?.id;});
    if(['diary','explore','reflect'].includes(kind))for(const task of [...(this.tasks||[])])if(!before.has(task)){
      const follow=task.then(async()=>{
        if(this.disposed)return;const p=this.store.read(id),job=p.jobs.find(j=>j.id===jobId);
        if(!job||job.notified)return;
        this.store.update(id,p=>{p.jobs.find(j=>j.id===jobId).notified=true;});
        const result=kind==='explore'?p.wishes.find(w=>w.id===input?.wishId)?.result:kind==='diary'?p.diaries[job.date]?.text:'';
        try{await this.reactToEvent(id,'刚才的'+({diary:'写日记',explore:'探索学习',reflect:'整理经历'}[kind])+'任务'+(job.status==='done'?'实际完成':'没有完成：'+job.message)+'。实际结果：'+cut(result,1200)+'。在对话里自然告诉爸爸结果，不能冒充查到了更多内容。');}catch(e){this.store.update(id,p=>{worldOf(p).error=cut(e.message);});}
      });this.tasks.add(follow);void follow.finally(()=>this.tasks.delete(follow));
    }return jobId;
  };
  Runtime.prototype.route=async function(deps,input){
    if(input.rest!=='humanity/companion/world'){
      const result=await old.route.call(this,deps,input);
      const endpoint=input.rest.split('/').at(-1);
      if(input.method==='POST'&&result?.obj?.ok&&['memory','diary','wish'].includes(endpoint)){
        const who=deps.requirePet(input.url.searchParams,()=>deps.readConfig());
        if(who.ok){let o;try{o=JSON.parse(input.body||'{}');}catch{o={};}
          const descriptions={memory:'爸爸整理了我的记忆',diary:'爸爸编辑了我的日记',wish:'爸爸调整了我的小念想'};
          try{result.obj.reaction={ok:true,text:await this.reactToEvent(who.petId,descriptions[endpoint]+'；实际操作：'+cut(JSON.stringify(o),500)+'；只依据更新后的真实存档回应')};}
          catch(e){result.obj.reaction={ok:false,message:cut(e.message)};}
        }
      }return result;
    }
    const json=(obj,status=200)=>({kind:'json',obj,status,headers:{'cache-control':'no-store'}});
    const who=deps.requirePet(input.url.searchParams,()=>deps.readConfig());if(!who.ok)return who.res;
    const id=who.petId;this.bind(id,{...deps,humanity:()=>deps.humanityStore.snapshot(id)});this.refreshSpace(id);
    try{
      if(input.method==='GET')return json({ok:true,world:this.bodySnapshot(id)});
      if(input.method!=='POST')return json({ok:false,message:'请使用 GET 或 POST'},405);
      const o=JSON.parse(input.body||'{}');if(!o || typeof o!=='object' || Array.isArray(o))throw Error('请求无效');
      if(o.action==='receipt')return json({ok:true,world:this.bodyReceipt(id,o)});
      if(o.action==='stop'){this.bodyControllers?.get(id)?.abort();this.store.update(id,p=>{const c=worldOf(p).command;if(c)c.status='interrupted';});return json({ok:true,world:this.bodySnapshot(id)});}
      if(o.action==='invite'){
        const invoke=globalThis[Symbol.for('dsh.pet.event.chat.v1')];if(typeof invoke!=='function')throw Error('聊天服务还没准备好');
        const result=await invoke(id,'【爸爸邀请我】'+cut(o.text,300)+'。请结合身体状况，回应并用身体协议决定实际动作。');
        if(!result.ok)return json(result,503);return json({ok:true,world:this.bodySnapshot(id)});
      }
      throw Error('未知世界操作');
    }catch(e){return json({ok:false,message:cut(e.message)},400);}
  };
  Runtime.prototype.dispose=function(){for(const c of this.bodyControllers?.values()||[])c.abort();return old.dispose.call(this);};
}
