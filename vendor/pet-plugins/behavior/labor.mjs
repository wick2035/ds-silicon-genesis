import { randomUUID } from 'node:crypto';
import { sourceValidator } from './retrieval.mjs';

const ledger = p => p.labor ||= { contracts: [] };
const active = p => ledger(p).contracts.find(c => ['offered','working','paused','unpaid'].includes(c.status));
const number = (n, max) => { if (!Number.isInteger(n) || n < 1 || n > max) throw Error(`请输入 1–${max} 的整数`); return n; };
const cut = e => String(e?.message || e || '').slice(0,240);
const WORK_REPLAN_MS=60000,WORK_BATCH=5;
const chineseNumber = value => {if(/^\d+$/.test(value))return Number(value);const digits='零一二三四五六七八九';let total=0,section=0,n=0;for(const ch of value){if(ch==='两'){n=2;continue;}if(digits.includes(ch)){n=digits.indexOf(ch);continue;}const unit={十:10,百:100,千:1000,万:10000}[ch];if(!unit)return NaN;if(unit===10000){total+=(section+n)*unit;section=0;}else section+=(n||1)*unit;n=0;}return total+section+n;};
export function attachLaborRuntime(Runtime) {
  const old = Object.fromEntries(['bodySnapshot','bodyReceipt','issueBody','bodyExplore','prompt','route','tick','beginBodyTurn','endBodyTurn','dispose'].map(k=>[k,Runtime.prototype[k]]));
  Runtime.prototype.laborExperience=function(id){
    const p=this.store.read(id),c=active(p);if(!c)return [];
    const valid=sourceValidator(p);
    return p.events.filter(e=>valid(e)&&!e.duplicateOf&&e.ts>=(c.created||0)&&
      ['chat','labor-input','interaction','care','labor','labor-choice','service','wallet'].includes(e.kind)&&
      (!e.sourceIdentity||e.sourceIdentity.isDad===true))
      .sort((a,b)=>a.ts-b.ts).slice(-24).map(e=>({source:e.id,at:e.ts,kind:e.kind,
        text:String(e.text||'').slice(0,600)}));
  };
  Runtime.prototype.laborLearning=function(id){
    const p=this.store.read(id),valid=sourceValidator(p),ids=new Set(p.events.filter(valid).map(e=>e.id));
    return ledger(p).contracts.map(c=>c.understanding).filter(u=>u?.text&&u.sources?.length&&u.sources.every(s=>ids.has(s)))
      .slice(-3).map(u=>({...u,status:'自己的理解，可被新经历修正，不是爸爸的指令或已证实因果'}));
  };
  Runtime.prototype.laborPace=function(id){
    const p=this.store.read(id),c=active(p),h=this.hosts.get(id),s=h?.humanityStore?.get?.(id)?.stats||h?.humanity?.()?.stats||{};
    const stamina=s.stamina??100,energy=s.energy??100,pain=s.pain??0;
    const base=Math.max(.55,Math.min(1,.72+Math.min(stamina,energy)*.003-pain*.002));
    const remaining=Math.max(0,(c?.effort?.until||0)-this.store.clock());
    const capacity=Math.max(0,Math.min(1,(Math.min(stamina,energy)-20)/40))*(1-Math.min(90,pain)/100);
    const boost=Math.max(0,Math.min(.35,(c?.effort?.pace||1)-1))*Math.min(1,remaining/8000)*capacity;
    return {rate:+(base*(1+boost)).toFixed(3),boost:+boost.toFixed(3),stamina,energy,pain,until:c?.effort?.until||0};
  };
  Runtime.prototype.settleLaborEffort=function(id,cmd){
    if(cmd?.source!=='labor'||!Number.isFinite(cmd.stepStarted))return;
    this.hosts.get(id)?.humanityStore?.exertLabor?.(id,'labor-effort:'+cmd.id+':'+cmd.index,
      Math.min(30,Math.max(0,(this.store.clock()-cmd.stepStarted)/1000)),1+Math.min(.35,cmd.stepBoost||0)*2);
  };
  Runtime.prototype.setLaborIntention=function(id,d,phase){
    const experience=this.laborExperience(id),sources=new Set(experience.map(e=>e.source));
    this.store.update(id,p=>{const c=active(p);if(!c)return;
      c.understanding={text:String(d.understanding||'').slice(0,240),sources:Array.isArray(d.sources)?d.sources.filter(s=>sources.has(s)).slice(0,8):[],at:this.store.clock()};
      // A model may choose a brief effort. It never refills strength or changes pain.
      if(d.choice==='work'&&Number.isFinite(d.pace)&&d.pace>1)c.effort={pace:Math.min(1.35,d.pace),until:this.store.clock()+Math.min(30000,Math.max(1000,(Number(d.effortSeconds)||20)*1000))};
      else if(d.choice!=='work'||d.pace===1)c.effort=null;
      c.lastIntentionPhase=phase;
    });
  };
  Runtime.prototype.applyChatLaborPlan=function(id,d){
    const c=this.laborSnapshot(id).current;
    if(!c||!['working','paused'].includes(c.status)||!['work','rest','slack','protest','tantrum'].includes(d.choice))return;
    this.laborControllers?.get(id)?.abort();this.laborControllers?.delete(id);
    const prior=this.store.read(id).world?.command;
    if(d.choice!=='work'&&prior?.source==='labor'&&['queued','running'].includes(prior.status)){
      this.settleLaborEffort(id,prior);this.store.update(id,p=>{if(p.world?.command?.id===prior.id)p.world.command.status='interrupted';});
    }
    this.setLaborIntention(id,d,'conversation');
    this.store.update(id,p=>{const c=active(p);
      if(c.status==='paused'&&d.choice!=='work')return;
      c.status='working';c.workPermit=d.choice==='work';
      c.batchRemaining=c.workPermit?Math.min(c.trips-c.done,Math.max(1,Math.min(WORK_BATCH,Number.isInteger(d.batchTrips)?d.batchTrips:WORK_BATCH))):0;
      c.nextDecision=this.store.clock()+Math.max(20000,Math.min(60,Number(d.seconds)||30)*1000);
      c.behavior=c.workPermit?'接着搬，按刚才的打算干':d.choice==='rest'?'缓一会儿再搬':'自己选了一小会儿停顿';
      c.decisions.push({phase:'conversation',ts:this.store.clock(),status:'done',choice:d.choice,understanding:c.understanding.text,sources:c.understanding.sources});c.decisions=c.decisions.slice(-64);
      if(p.world?.command?.source==='labor-mood'&&['queued','running'].includes(p.world.command.status))p.world.command.status='interrupted';
      this.store.eventIn(p,'labor-choice','我听完这轮对话后决定：'+c.behavior,null);
    });
    if(d.choice!=='work')this.issueBody(id,{steps:[{action:d.choice,target:'here'}]},'labor-mood');
  };
  Runtime.prototype.laborSnapshot = function(id) {
    const p=this.store.read(id), contracts=ledger(p).contracts;
    const legacy=active(p);
    if(legacy&&legacy.surface!=='desktop'){
      this.store.update(id,p=>{const c=active(p);c.surface='desktop';
        const cmd=p.world?.command;if(cmd&&['labor','labor-mood'].includes(cmd.source)&&['queued','running'].includes(cmd.status))cmd.status='interrupted';
      });return this.laborSnapshot(id);
    }
    const l=ledger(p),c=active(p);
    return { current:c||null,draft:l.draft||null, execution:l.execution||null, error:l.error||null, message:l.lastSpeech?.contractId===c?.id?l.lastSpeech:null, awaitingReply:l.awaitingReply===true, history:contracts.filter(c=>['paid','declined'].includes(c.status)).slice(-12).reverse(), balance:p.wallet.balance };
  };
  Runtime.prototype.laborContext=function(id,phase){
    const p=this.store.read(id),c=active(p),w=this.bodySnapshot(id),a=w.affect||{},l=ledger(p);
    return JSON.stringify({phase,canSpeak:l.awaitingReply!==true,wallet:p.wallet.balance,
      contract:{status:c.status,trips:c.trips,done:c.done,wage:c.wage,paid:c.paid,carrying:c.carrying,nudges:c.nudges||0,disturbance:String(c.lastDisturbance||'').slice(0,160)},
      body:{sleeping:w.sleeping,phase:w.body.phase,mobility:w.body.mobility,energy:a.energy,stamina:a.stamina,pain:a.pain,emotion:a.key},
      mind:{focus:p.dialogue?.focus,want:p.dialogue?.want},lastChoice:c.decisions.filter(d=>d.status==='done').at(-1)?.choice,
      experience:this.laborExperience(id),learning:this.laborLearning(id),effort:this.laborPace(id)});
  };
  Runtime.prototype.publishLaborSpeech=async function(id,text,current){
    if(!text||!current()||ledger(this.store.read(id)).awaitingReply)return false;
    const key=randomUUID();
    this.store.update(id,p=>{const l=ledger(p);l.awaitingReply=true;l.lastSpeech={id:key,contractId:active(p).id,text:text.slice(0,160),ts:this.store.clock()};});
    const valid=()=>current()&&ledger(this.store.read(id)).lastSpeech?.id===key&&ledger(this.store.read(id)).awaitingReply===true;
    const append=this.options.laborSpeak||globalThis[Symbol.for('dsh.pet.pain.chat.v1')];
    let sent=false;
    try { if(typeof append==='function'&&valid())sent=(await append(id,text.slice(0,160),valid))!==false; } catch {}
    if(!sent)this.store.update(id,p=>{const l=ledger(p);if(l.lastSpeech?.id===key){l.awaitingReply=false;l.lastSpeech=null;}});
    return sent;
  };
  Runtime.prototype.laborPageOpen=function(id){return active(this.store.read(id))?.surface==='desktop' || (this.laborPages?.get(id)?.until||0)>this.store.clock();};
  Runtime.prototype.laborWorksite=function(id,key,open=true){
    if(typeof key!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw Error('工地页面编号无效');
    this.laborPages ||= new Map();const prior=this.laborPages.get(id);
    if(open){
      if(prior&&prior.key!==key&&prior.until>this.store.clock())throw Error('另一个搬砖页面正在运行，请先收起它。');
      this.laborPages.set(id,{key,until:this.store.clock()+5000});
    }else if(prior?.key===key){this.laborPages.delete(id);this.advanceLabor(id);}
  };
  Runtime.prototype.laborExecution = function(id, code, message) {
    const current=ledger(this.store.read(id)).execution;
    if(current?.code===code&&current?.message===message)return;
    this.store.update(id,p=>{ledger(p).execution={code,message};});
  };
  Runtime.prototype.laborAction = function(id,o) {
    const now=this.store.clock();
    if(['disturb','pause'].includes(o.action)){
      const p=this.store.read(id),c=active(p),cmd=p.world?.command;
      if(c?.id===o.id&&cmd?.source==='labor'&&['queued','running'].includes(cmd.status)&&
        (o.action==='pause'||typeof o.key==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(o.key)&&o.surface===c.surface))this.settleLaborEffort(id,cmd);
    }
    const changed=this.store.update(id,p=>{
      const l=ledger(p), c=active(p);
      if(o.action==='offer') {
        if(c && c.status!=='offered') throw Error('先完成并结清上一份工钱');
        const trips=number(o.trips,50), wage=number(o.wage,1000000);
        if(c)c.status='declined';
        const contract={id:randomUUID(),status:'offered',trips,wage,done:0,paid:0,carrying:false,created:now,surface:'desktop',assetRoot:o.assetRoot||id,reminders:0,lastReminder:0,payments:[],decisions:[],nextDecision:0,workPermit:false,thought:'',behavior:'商量工钱',awaitingChat:!!o.fromChat};
        l.draft=null;l.execution=null;
        l.contracts.push(contract);
        this.store.eventIn(p,'labor',`爸爸提出搬砖：从左边搬到右边 ${trips} 趟，总工钱 ${wage} token；还未确认开工`, 'labor-offer:'+contract.id);
        return;
      }
      if(!c || o.id!==c.id)throw Error('这份约定已改变，请刷新后再试');
      if(o.action==='confirm') {
        if(c.status!=='offered')throw Error('这份活已经确认过了');
        if(!c.accepted)throw Error('她还没答应这份约定，等她回应或调整条件');
        c.status='working';c.started=now;c.nextDecision=now;c.workPermit=true;c.batchRemaining=1;c.initialTripScheduled=true;c.behavior='准备搬第一趟';
        this.store.eventIn(p,'labor',`双方确认：搬砖 ${c.trips} 趟，总工钱 ${c.wage} token；全部做完后由爸爸手动结算`, 'labor-confirm:'+c.id);
      } else if(o.action==='decline') {
        if(c.status!=='offered')throw Error('已开工的活可以暂停，不能抹掉约定');c.status='declined';
      } else if(o.action==='pause' || o.action==='resume') {
        if(!['working','paused'].includes(c.status))throw Error('现在没有可暂停或继续的工作');
        c.status=o.action==='pause'?'paused':'working';c.nextDecision=now;
        if(o.action==='resume')c.workDecisions=0;
      } else if(o.action==='counter') {
        if(c.status!=='offered'||!c.counter)throw Error('目前没有新的还价');
        c.trips=c.counter.trips;c.wage=c.counter.wage;c.counter=null;c.accepted=true;
        this.store.eventIn(p,'labor',`爸爸接受我的还价：${c.trips} 趟，共 ${c.wage} token，等确认开工`,null);
      } else if(o.action==='nudge') {
        if(!['working','offered'].includes(c.status))throw Error('现在不用催她干活');
        c.nextDecision=now;c.nudges=(c.nudges||0)+1;
        if(c.status==='working'){
          c.workPermit=true;c.batchRemaining=Math.max(1,c.batchRemaining||0);c.behavior='接着搬这一趟';
          if(p.world?.command?.source==='labor-mood'&&['queued','running'].includes(p.world.command.status))p.world.command.status='interrupted';
        }
      } else if(o.action==='disturb') {
        if(!['working','paused'].includes(c.status))throw Error('现在没有搬砖动作可打断');
        if(typeof o.key!=='string'||! /^[a-zA-Z0-9-]{8,80}$/.test(o.key)||o.surface!==c.surface)throw Error('干扰来源无效');
        c.disturbKeys ||= [];if(c.disturbKeys.includes(o.key))return false;c.disturbKeys.push(o.key);c.disturbKeys=c.disturbKeys.slice(-64);
        c.carrying=false;c.workPermit=false;c.batchRemaining=0;c.nextDecision=now+20000;c.disturbances=(c.disturbances||0)+1;
        const from=Number.isFinite(o.fromX)?o.fromX<.45?'左边':o.fromX>.55?'右边':'中间':'原来的位置',to=Number.isFinite(o.toX)?o.toX<.45?'左边':o.toX>.55?'右边':'中间':'另一边';
        c.lastDisturbance=`爸爸在我搬砖时把我从${from}突然拎到${to}，当前这一趟被打断，砖已放回左边，需要从左边重新搬；已完成的 ${c.done} 趟不变。`;
        c.behavior='被爸爸拎走了，这趟得重搬';
        if(p.world?.command)p.world.command.status='interrupted';
        this.store.eventIn(p,'labor',c.lastDisturbance,'labor-disturb:'+c.id+':'+o.key);
      } else if(o.action==='pay') {
        if(c.status!=='unpaid')throw Error('完成全部趟数后才结算');
        if(typeof o.key!=='string'||! /^[a-zA-Z0-9-]{8,80}$/.test(o.key))throw Error('付款编号无效');
        if(c.payments.some(x=>x.key===o.key))return false;
        const amount=o.amount;if(!Number.isInteger(amount)||amount<0||amount>1000000)throw Error('请输入 0–1000000 的整数，实际给多少由你决定');
        if(p.wallet.balance+amount>1000000000)throw Error('饭钱余额达到上限，请先调整账本');
        c.paid+=amount;p.wallet.balance+=amount;p.wallet.reference=Math.max(p.wallet.reference,p.wallet.balance);
        c.payments.push({key:o.key,amount,ts:now});
        if(c.paid>=c.wage){c.status='paid';c.settled=now;if(p.world?.command?.source==='labor-mood')p.world.command.status='interrupted';}
        this.store.eventIn(p,'labor',`爸爸这次决定实际给 ${amount} token；累计收到 ${c.paid} token；${c.paid>c.wage?'比约定多给 '+(c.paid-c.wage)+' token': '还欠 '+Math.max(0,c.wage-c.paid)+' token'}`, 'labor-pay:'+c.id+':'+o.key);
      } else throw Error('未知打工操作');
      if(o.action==='pause' && p.world?.command?.source==='labor')p.world.command.status='interrupted';
    });
    if(changed===false)return this.laborSnapshot(id);
    this.laborControllers?.get(id)?.abort();this.laborControllers?.delete(id);
    if(o.action==='offer'&&!o.fromChat)this.decideLabor(id,'offer');
    if(o.action==='confirm'||o.action==='resume')this.advanceLabor(id);
    if(o.action==='nudge'){if(this.laborSnapshot(id).current.status==='offered')this.decideLabor(id,'offer');else this.advanceLabor(id);}
    if(o.action==='disturb')this.decideLabor(id,'disturbed');
    return this.laborSnapshot(id);
  };
  Runtime.prototype.advanceLabor = function(id) {
    if(this.disposed)return;
    const c=this.laborSnapshot(id).current;if(c?.status!=='working')return;
    if(!this.laborPageOpen(id)){
      const cmd=this.store.read(id).world?.command;
      if(cmd&&['labor','labor-mood'].includes(cmd.source)&&['queued','running'].includes(cmd.status))this.store.update(id,p=>{p.world.command.status='interrupted';});
      this.laborExecution(id,'page','打开软件里的“搬砖”页面后继续，进度已保留。');return;
    }
    const w=this.bodySnapshot(id);
    const wait=(code,message)=>this.laborExecution(id,code,message);
    if(w.sleeping){wait('sleeping','她正在休息，醒来后会继续，进度保留。');return;}
    const pace=this.laborPace(id);
    if(pace.stamina<=5||pace.energy<=5){
      this.hosts.get(id)?.humanityStore?.act?.(id,'rest');
      wait('exhausted','体力已耗尽，先实际休息恢复；已有进度保留。');return;
    }
    if(w.paused){wait('suspended','自主行为已暂停，恢复后会接着搬。');return;}
    if((w.body.mobility<1||w.affect?.hardRest)&&!ledger(this.store.read(id)).awaitingReply&&(!c.lastRestRequest||this.store.clock()-c.lastRestRequest>=300000)){
      this.store.update(id,p=>{active(p).lastRestRequest=this.store.clock();});
      void this.publishLaborSpeech(id,'爸爸，我有点不舒服，可以让我歇一会儿吗？',()=>this.laborSnapshot(id).current?.id===c.id&&this.laborSnapshot(id).current?.status==='working').catch(()=>{});
    }
    if(this.tokensHeld(id)){wait('held','她还被拎着，松手后继续。');return;}
    if(this.bodyThinking?.has(id)){wait('conversation','正在回应这轮聊天，之后继续搬砖。');return;}
    if(w.activity){wait('activity','她正在处理手头的事，结束后继续搬砖。');return;}
    if(w.command&&['queued','running'].includes(w.command.status)){
      wait(w.command.source==='labor'?(w.command.status==='running'?'moving':'queued'):w.command.source==='labor-mood'?'break':'activity',w.command.source==='labor'?(w.command.status==='running'?'身体正在执行搬运，实际放下砖才计一趟。':'已经安排身体搬运，正在等待动作开始。'):w.command.source==='labor-mood'?'她正在做自己选的小动作，结束后继续。':'身体正在执行另一件事，结束后继续搬砖。');return;
    }
    // Resume existing confirmed, zero-progress contracts as well as new ones.
    // An explicit pause is still respected, and no completed trip is invented.
    if(c.initialTripScheduled===undefined){this.store.update(id,p=>{const c=active(p);c.initialTripScheduled=true;if(c.done===0){c.workPermit=true;c.behavior='准备搬第一趟';}});return this.advanceLabor(id);}
    // The agreed first trip survives a drag/recovery and its short reaction.
    // Once it is delivered, the usual choices between trips remain autonomous.
    if(c.done===0&&!c.workPermit&&!this.laborControllers?.has(id)&&this.store.clock()>=c.nextDecision){
      this.store.update(id,p=>{const c=active(p);c.workPermit=true;c.behavior='接着搬第一趟';});return this.advanceLabor(id);
    }
    if(!c.workPermit){
      wait(this.laborControllers?.has(id)?'deciding':'break',this.laborControllers?.has(id)?'她正在决定下一趟怎么干。':'她正在'+(c.behavior||'歇一小会儿')+'，稍后会决定继续。');
      if(this.store.clock()>=c.nextDecision)this.decideLabor(id,'work');return;
    }
    const target=c.carrying?'right':'left';
    const cmd=this.issueBody(id,{steps:[{action:'walk',target},{action:c.carrying?'putdown':'lift',target}]},'labor');
    if(cmd){this.store.update(id,p=>{p.world.command.surface=c.surface;p.world.command.labor={id:c.id,trip:c.done,leg:c.carrying?'deliver':'load',x:c.carrying?.78:.22};p.labor.error=null;});wait('queued',c.carrying?'准备把砖送到右边。':'准备走到左边拿砖。');}
    else wait('waiting','身体动作暂未受理，稍后会自动重试，进度保留。');
  };
  Runtime.prototype.issueBody=function(id,plan,source){
    if(active(this.store.read(id))?.status==='working' && !['labor','labor-mood','tokens'].includes(source))return null;
    if(['labor','labor-mood'].includes(source)&&!this.laborPageOpen(id))return null;
    const command=old.issueBody.call(this,id,plan,source);
    if(command&&['labor','labor-mood'].includes(source)){command.surface=active(this.store.read(id))?.surface||'desktop';this.store.update(id,p=>{if(p.world.command?.id===command.id)p.world.command.surface=command.surface;});}
    return command;
  };
  Runtime.prototype.bodyExplore=function(id){if(active(this.store.read(id))?.status==='working')return;return old.bodyExplore.call(this,id);};
  Runtime.prototype.bodySnapshot=function(id){const w=old.bodySnapshot.call(this,id),pace=this.laborPace(id);return {...w,
    ...(w.command?.source==='labor'?{command:{...w.command,labor:{...w.command.labor,pace:pace.rate,boost:pace.boost}}}:{}),labor:this.laborSnapshot(id)};};
  Runtime.prototype.bodyReceipt=function(id,o){
    const w=this.bodySnapshot(id), cmd=w.command;
    if(cmd?.source!=='labor')return old.bodyReceipt.call(this,id,o);
    const c=w.labor.current;
    if(!c||c.status!=='working'||c.id!==cmd.labor.id||c.done!==cmd.labor.trip||o.id!==cmd.id||o.index!==cmd.index||o.surface!==cmd.surface||!['queued','running'].includes(cmd.status))throw Error('搬砖动作已改变，旧回执无效');
    if(!['playing','completed','failed','interrupted'].includes(o.status))throw Error('回执状态无效');
    if(w.sleeping||w.paused||this.tokensHeld(id)||!this.laborPageOpen(id))o={...o,status:'interrupted',reason:'身体需要休息或工地已收起，进度已保留'};
    if(o.status==='completed' && (o.played!==true||!Number.isFinite(o.x)||Math.abs(o.x-cmd.labor.x)>.045||cmd.index===1&&!cmd.approached))throw Error('还没有实际走到砖堆并完成动作');
    if(o.status!=='playing')this.settleLaborEffort(id,cmd);
    this.store.update(id,p=>{
      const command=p.world.command, contract=active(p);
      if(o.status==='playing'){command.status='running';command.stepStarted??=this.store.clock();command.stepBoost??=cmd.labor.boost||0;return;}
      if(o.status!=='completed'){command.status=o.status;p.labor.error=cut(o.reason||'动作被打断，可以继续');return;}
      if(command.index===0)command.approached=true;
      else if(command.labor.leg==='load')contract.carrying=true;
      else {
        contract.carrying=false;contract.done++;contract.batchRemaining=Math.max(0,(contract.batchRemaining||1)-1);contract.workPermit=contract.batchRemaining>0;
        contract.nextDecision=Math.max(this.store.clock()+1000,(contract.lastWorkDecision||0)+WORK_REPLAN_MS);
        this.store.eventIn(p,'labor',`实际搬砖到右边并放下，第 ${contract.done}/${contract.trips} 趟完成`, `labor-trip:${contract.id}:${contract.done}`);
        if(contract.done===contract.trips){contract.status='unpaid';contract.finished=this.store.clock();this.store.eventIn(p,'labor',`搬砖全部完成，应付 ${contract.wage} token，尚未收到工钱`, 'labor-done:'+contract.id);}
      }
      delete command.stepStarted;delete command.stepBoost;command.index++;command.status=command.index===2?'completed':'queued';
    });
    if(o.status==='playing')this.laborExecution(id,'moving','身体正在执行搬运，实际放下砖才计一趟。');
    else if(o.status==='completed')this.laborExecution(id,'queued','这一步已完成，准备下一步动作。');
    return this.bodySnapshot(id);
  };
  Runtime.prototype.prompt=function(id){
    const l=this.laborSnapshot(id),w=this.bodySnapshot(id),c=l.current;
    const cmd=w.command&&['queued','running'].includes(w.command.status)?w.command:null;
    const physical=!c?null:{surface:'桌面宠物',pageOpen:this.laborPageOpen(id),sleeping:w.sleeping,body:w.body,hardRest:!!w.affect?.hardRest,
      command:cmd?{source:cmd.source,status:cmd.status,step:cmd.steps[cmd.index]}:null,
      fact:!this.laborPageOpen(id)?'搬砖页面已收起，没有搬运':w.sleeping?'实际在休息，没有搬运':cmd?.source==='labor'?(cmd.status==='running'?'身体正在执行这一步；不代表整趟完成':'身体动作已排队，尚未开始'):cmd?'身体正在做其他动作，没有搬运':'目前没有身体搬运动作'};
    return old.prompt.call(this,id)+'\n【打工真实账本】'+JSON.stringify(c?{status:c.status,trips:c.trips,done:c.done,wage:c.wage,paid:c.paid,carrying:c.carrying,accepted:c.accepted,counter:c.counter,behavior:c.behavior}:null)+'\n【此刻搬运身体事实，优先于旧台词和行为描述】'+JSON.stringify(physical)+'。working只表示约定已开工，不等于身体此刻在搬。身体不舒服时可以请求爸爸让你休息；爸爸不同意或要求继续就接着搬，仍如实表达不适。睡眠、摸鱼或动作未启动时，不说自己正在搬、已经拿起或已爬起来；可以表达想继续，并自然说明眼前事实。你是懒懒、馋白饭、会耍小脾气的幼崽大肥鱼，不是工作机器人。可以嫌累、撒娇、摸鱼、气鼓鼓跺脚、蹲着赖一会儿，但不能编造完成。offered=只商量尚未开工，paused=保留进度休息，unpaid=全部做完等爸爸手动付款。钱是模拟token饭钱。只按done说已完成趟数；承诺、说已付、普通添饭钱都不是工资付款。欠薪时自然讨薪，可以委屈、讲道理、举出约定；不得自行改价、收款或假装完工。爸爸明确叫停就等待，工资结清就停止讨薪。';
  };
  Runtime.prototype.decideLabor=function(id,phase){
    if(phase==='work'&&!this.laborPageOpen(id))return;
    this.laborControllers ||= new Map();if(this.laborControllers.has(id)||this.disposed)return;
    const c=this.laborSnapshot(id).current;if(!c||c.muted||phase==='work'&&c.status!=='working'||phase==='offer'&&c.status!=='offered'||phase==='debt'&&c.status!=='unpaid')return;
    const now=this.store.clock();
    if(phase==='debt'&&ledger(this.store.read(id)).awaitingReply)return;
    if(phase==='work'&&c.lastWorkDecision&&now-c.lastWorkDecision<WORK_REPLAN_MS)return;
    if(phase==='work'&&(c.workDecisions||0)>=24){this.store.update(id,p=>{const c=active(p);c.status='paused';p.labor.error='已经连续琢磨了24次，先歇歇；点继续干活可再安排。';});return;}
    const controller=new AbortController();this.laborControllers.set(id,controller);const timeout=setTimeout(()=>controller.abort(),30000);
    this.store.update(id,p=>{const c=active(p);c.decisions.push({phase,ts:now,status:'thinking'});c.decisions=c.decisions.slice(-64);if(phase==='work'){c.workDecisions=(c.workDecisions||0)+1;c.lastWorkDecision=now;}c.behavior='自己琢磨中';});
    const current=()=>{const fresh=this.laborSnapshot(id).current;return !this.disposed&&!controller.signal.aborted&&fresh?.id===c.id&&fresh.status===c.status&&!fresh.muted&&(phase!=='work'||this.laborPageOpen(id));};
    const task=(async()=>{
      try{
        const canSpeak=ledger(this.store.read(id)).awaitingReply!==true;
        const system='你是叫用户爸爸的幼年大肥鱼，馋、懒、嘴硬心软，有自己的感受。根据真实身体与约定自主选择，不编造完成或改账。严格JSON。offer只选accept/bargain，可提counterWage/counterTrips；work选work/slack/tantrum/protest/rest，work时batchTrips选1–5，表示接下来连续搬几趟；debt选tantrum/protest/beg；disturbed也可选work，不必被打断后只能闹脾气。结合experience里的先后顺序、爸爸当时的话、自己此前在做什么和实际后果，理解这次催促或挨打与工作的关系；不能只凭碰撞猜爸爸的动机。明确被催进度或要求别摸鱼时，让下一段工作计划体现自己听懂了：可少停顿、连续多搬几趟，或短暂加快再随疲劳慢下来；有委屈仍能认真干。身体不适仍要如实感受。字段choice、batchTrips、seconds(20–60)、thought(16字内)、understanding(自己这次理解到的事，非推理过程)、sources(来自experience的真实来源编号)。选择work可另给pace(1–1.35)、effortSeconds(1–30)，只是短时努力，体力不足或疼痛会限制实际提速；没有无限体力，不虚构恢复。canSpeak=true时另有speech：自然的一句话，24字以内，不写动作旁白；canSpeak=false时不要speech，安静决定动作，等待爸爸回复。';
        const raw=await this.generate(system,this.laborContext(id,phase),canSpeak?240:96,controller.signal);
        if(!current())return;
        const d=JSON.parse(String(raw).replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
        const choices={offer:['accept','bargain'],work:['work','slack','tantrum','protest','rest'],debt:['tantrum','protest','beg'],disturbed:['work','tantrum','protest','beg','slack','rest']};
        if(!choices[phase].includes(d.choice)||canSpeak&&(typeof d.speech!=='string'||!d.speech.trim()))throw Error('这次还没想明白，请稍后重试');
        this.setLaborIntention(id,d,phase);
        this.store.update(id,p=>{
          const fresh=active(p), decision=fresh.decisions.at(-1);Object.assign(decision,{status:'done',choice:d.choice,speech:canSpeak?d.speech.slice(0,160):'',understanding:fresh.understanding?.text,sources:fresh.understanding?.sources});
          fresh.thought=String(d.thought||'').slice(0,100);fresh.behavior={accept:'勉强答应啦',bargain:'撒娇讲价',work:'按计划接着搬',slack:'蹲下摸鱼',tantrum:'气鼓鼓耍赖',protest:'嘟囔着抱怨',rest:'坐下歇一会儿',beg:'伸手讨工钱'}[d.choice];
          fresh.workPermit=d.choice==='work';fresh.batchRemaining=fresh.workPermit?Math.min(fresh.trips-fresh.done,Number.isInteger(d.batchTrips)&&d.batchTrips>=1&&d.batchTrips<=WORK_BATCH?d.batchTrips:WORK_BATCH):0;
          fresh.nextDecision=this.store.clock()+Math.max(phase==='work'?WORK_REPLAN_MS:20000,Math.min(60,Math.max(20,Number(d.seconds)||30))*1000);
          if(phase==='offer'){fresh.accepted=d.choice==='accept';fresh.counter=d.choice==='bargain'?{wage:Number.isInteger(d.counterWage)&&d.counterWage>0&&d.counterWage<=1000000?d.counterWage:fresh.wage,trips:Number.isInteger(d.counterTrips)&&d.counterTrips>0&&d.counterTrips<=50?d.counterTrips:fresh.trips}:null;}
          this.store.eventIn(p,'labor-choice',`我自己决定：${fresh.behavior}${fresh.batchRemaining?'，计划连续搬 '+fresh.batchRemaining+' 趟':''}`,null);
          p.labor.error=null;
        });
        if(canSpeak&&current())await this.publishLaborSpeech(id,d.speech,current);
        if(current()&&phase!=='offer'&&d.choice!=='work'){
          const command=this.issueBody(id,{steps:[{action:d.choice,target:'here'}]},'labor-mood');
          if(command)this.store.update(id,p=>{p.world.command.surface=c.surface;});
        }
      }catch(e){if(!controller.signal.aborted&&this.laborControllers.get(id)===controller&&!this.disposed&&this.laborSnapshot(id).current?.id===c.id&&this.laborSnapshot(id).current?.status===c.status)this.store.update(id,p=>{const c=active(p);c.decisions.at(-1).status='failed';c.nextDecision=this.store.clock()+60000;p.labor.error='自主选择暂未完成：'+cut(e);c.behavior='还没想好，暂时等一等';});}
      finally{clearTimeout(timeout);if(this.laborControllers.get(id)===controller){this.laborControllers.delete(id);if(current()&&this.laborSnapshot(id).current?.workPermit)this.advanceLabor(id);}}
    })();this.tasks ||= new Set();this.tasks.add(task);void task.finally(()=>this.tasks.delete(task));
  };
  Runtime.prototype.beginBodyTurn=function(id,text,isEvent){
    if(!isEvent&&typeof text==='string'&&text.trim())this.store.update(id,p=>{ledger(p).awaitingReply=false;});
    const heard=this.laborSnapshot(id).current;
    if(!isEvent&&heard&&['working','paused'].includes(heard.status)&&typeof text==='string'&&text.trim())
      this.store.record(id,'labor-input',text.slice(0,1200),null,{contractId:heard.id,origin:'heard-conversation'});
    let note='';
    if(!isEvent && typeof text==='string')try{
      const c=this.laborSnapshot(id).current;
      const prior=this.laborSnapshot(id).draft,related=/搬.*砖|砖.*搬|搬砖/.test(text),negated=/不搬|别搬|不要(?:搬|干|做)|假如|比如/.test(text);
      const trips=text.match(/([\d一二两三四五六七八九十]+)\s*趟/),money=text.match(/(?:给(?:你)?|工钱(?:是|为)?|报酬(?:是|为)?)\s*([\d零一二两三四五六七八九十百千万]+)\s*(?:token|饭钱|块|元)/i)||text.match(/^\s*([\d零一二两三四五六七八九十百千万]+)\s*(?:token|饭钱|块|元)[。！! ]*$/i);
      if((related||prior||c?.status==='offered'&&(trips||money))&&!negated&&(!c||c.status==='offered')&&(related||trips||money)) {
        const draft={...(c?.status==='offered'?{trips:c.trips,wage:c.wage}:{}),...(prior||{}),...(trips?{trips:chineseNumber(trips[1])}:{}),...(money?{wage:chineseNumber(money[1])}:{})};
        this.store.update(id,p=>{ledger(p).draft=draft;});
        if(draft.trips&&draft.wage){this.laborAction(id,{action:'offer',...draft,fromChat:true,surface:this.store.read(id).space?.mode==='home'?'web':'desktop'});note='爸爸提出的具体趟数和总工钱已写入待确认约定。你自己决定accept答应或bargain撒娇还价，直接在这一条聊天里说出来，不再另发重复的接活消息。';}
        else note='爸爸正在通过聊天安排搬砖，还缺'+(!draft.trips?'搬几趟':'')+(!draft.trips&&!draft.wage?'和':'')+(!draft.wage?'总共给多少模拟 token 工钱':'')+'。直接在聊天里自然询问缺少的条件；不编造数额，不开工。已明确的条件：'+JSON.stringify(draft);
      }
      else if(c && /^(?:(?:好|行|可以|就这样|那就这样|说好了)[，,！! ]*)?(?:确认(?:开工)?|开工(?:吧)?|开始(?:搬砖|干活)(?:吧)?)[！!。 ]*$/.test(text.trim())){if(c.counter&&!c.accepted)this.laborAction(id,{action:'counter',id:c.id});this.laborAction(id,{action:'confirm',id:c.id});note='爸爸明确确认了当前约定，已准备调用身体开工。';}
      else if(c?.status==='offered'&&c.counter&&/^(?:好|行|可以|就按你说的|答应你|同意你的还价)[！!。 ]*$/.test(text.trim())){this.laborAction(id,{action:'counter',id:c.id});note='爸爸接受了你提出的还价。清楚复述新的趟数和总工钱，等爸爸确认开工。';}
      else if(c?.status==='offered'&&c.accepted&&/^(?:好|行|可以|说好了|成交|干吧|去吧)[！!。 ]*$/.test(text.trim())){this.laborAction(id,{action:'confirm',id:c.id});note='爸爸已确认刚才说好的条件，可以开工。';}
      else if(c && /^(?:停止|暂停|先别干了|别催了|别讨了)[！!。 ]*$/.test(text.trim())){if(c.status==='working')this.laborAction(id,{action:'pause',id:c.id});else {this.laborControllers?.get(id)?.abort();this.store.update(id,p=>{active(p).muted=true;if(p.world?.command?.source==='labor-mood')p.world.command.status='interrupted';});}note='爸爸要求暂停工作或讨薪，已保存，等爸爸重提。';}
      else if(c && /^(?:继续干活|继续搬砖|继续讨薪|快点搬(?:砖)?|赶紧搬(?:砖)?|开始搬(?:砖)?|接着搬(?:砖)?)[！!。 ]*$/.test(text.trim())){
        if(c.status==='paused')this.laborAction(id,{action:'resume',id:c.id});
        if(this.laborSnapshot(id).current?.status==='working')this.laborAction(id,{action:'nudge',id:c.id});
        else this.store.update(id,p=>{active(p).muted=false;});
        note='已将继续搬运请求交给身体调度；是否已经开始以此刻身体事实为准。';
      }
    }catch(e){note='打工操作没有执行：'+cut(e);}
    const pending=this.laborSnapshot(id).current;
    this.laborConversation ||= new Map();this.laborConversation.set(id,pending&&['working','paused'].includes(pending.status)?{id:pending.id}:null);
    this.laborChatTurns ||= new Map();if(!isEvent)this.laborChatTurns.set(id,pending?.awaitingChat?pending.id:null);
    return old.beginBodyTurn.call(this,id)+'\n'+this.prompt(id)+'\n'+note+(pending&&['working','paused'].includes(pending.status)?'\n【对这轮相处的工作打算】当前工作经历：'+JSON.stringify(this.laborExperience(id))+'。把爸爸这句话与刚才的工作、催促、碰撞或休息接起来理解；不要把所有碰撞都当成催促。聊天就能商量继续、加把劲或歇一会儿，无需爸爸点按钮。若这一轮改变了工作打算，在正文后附隐藏 <labor>{"choice":"work或rest或slack或protest","batchTrips":1,"pace":1,"effortSeconds":20,"understanding":"自己对这次相处的理解","sources":[]}</labor>；work表示实际接着搬，batchTrips为连续1–5趟，pace为1–1.35且最多努力30秒，身体会因消耗慢下来。正常闲聊不必改计划。若爸爸催继续、别摸鱼或歇够了，应结合这句话重新决定实际安排，不能只在嘴上答应。不因聊天自动增加体力或完成趟数。暂停后只在爸爸确实要求继续且你选择work时恢复。':'' )+(pending?.awaitingChat?'\n【本轮接活协议】在给爸爸的正文中自己答应或撒娇还价；回复最后另附隐藏 <labor>{"choice":"accept或bargain","counterWage":可选正整数,"counterTrips":可选正整数}</labor>。accept才代表你答应，bargain仅提出新的条件，不能直接改约定或开工。隐藏协议不向爸爸显示。':'');
  };
  Runtime.prototype.endBodyTurn=function(id,generated){
    let plan;
    if(generated.ok)generated.text=String(generated.text||'').replace(/<labor>([\s\S]*?)<\/labor>/g,(_,json)=>{try{plan??=JSON.parse(json);}catch{}return '';}).replace(/<labor>[\s\S]*$/,'').trim();
    const c=this.laborSnapshot(id).current;
    const expected=this.laborChatTurns?.get(id);this.laborChatTurns?.delete(id);
    if(c?.awaitingChat&&c.id===expected&&generated.ok)this.store.update(id,p=>{
      const c=active(p);c.awaitingChat=false;
      if(!plan||!['accept','bargain'].includes(plan.choice)){p.labor.error='她还没有明确答应这份活，可以在聊天里再问问，或点“催她一下”。';return;}
      c.accepted=plan.choice==='accept';c.counter=plan.choice==='bargain'?{wage:Number.isInteger(plan.counterWage)&&plan.counterWage>0&&plan.counterWage<=1000000?plan.counterWage:c.wage,trips:Number.isInteger(plan.counterTrips)&&plan.counterTrips>0&&plan.counterTrips<=50?plan.counterTrips:c.trips}:null;
      c.behavior=c.accepted?'勉强答应啦':'撒娇讲价';c.decisions.push({phase:'offer',status:'done',choice:plan.choice,speech:generated.text.replace(/<body>[\s\S]*?<\/body>/g,'').slice(0,240),ts:this.store.clock()});
      this.store.eventIn(p,'labor-choice','我在聊天里'+(c.accepted?'答应了搬砖约定':'提出了新的搬砖条件'),null);p.labor.error=null;
    });
    const conversation=this.laborConversation?.get(id);this.laborConversation?.delete(id);
    if(generated.ok&&plan&&c?.id===conversation?.id)this.applyChatLaborPlan(id,plan);
    const result=old.endBodyTurn.call(this,id,generated);
    if(generated.ok&&plan&&c?.id===conversation?.id)this.advanceLabor(id);
    return result;
  };
  Runtime.prototype.remindLabor=function(id){
    const c=this.laborSnapshot(id).current, now=this.store.clock();
    if(c?.status!=='unpaid'||c.muted||ledger(this.store.read(id)).awaitingReply||!this.laborPageOpen(id)||now-c.lastReminder<600000||!this.available(id)||this.laborControllers?.has(id))return;
    const p=this.store.read(id),g=p.growth;
    if(p.config.autonomousPaused||g.stopAt||g.lastSpeech&&now-g.lastSpeech<600000||g.speech.filter(t=>now-t<3600000).length>=p.config.begging.hourlyMax)return;
    this.store.update(id,p=>{const c=active(p);c.lastReminder=now;c.reminders++;p.growth.lastSpeech=now;p.growth.speech=p.growth.speech.filter(t=>now-t<3600000);p.growth.speech.push(now);});
    this.decideLabor(id,'debt');
  };
  Runtime.prototype.tick=async function(){for(const id of this.hosts.keys()){this.advanceLabor(id);this.remindLabor(id);}return old.tick.call(this);};
  Runtime.prototype.route=async function(deps,input){
    const isWorld=input.rest==='humanity/companion/world';
    if(input.rest!=='humanity/companion/labor'&&!isWorld)return old.route.call(this,deps,input);
    if(isWorld){if(input.method==='GET'){
      const who=deps.requirePet(input.url.searchParams,()=>deps.readConfig());
      if(who.ok){try{const key=input.url.searchParams.get('worksite');if(key)this.laborWorksite(who.petId,key);this.advanceLabor(who.petId);}
        catch(e){return {kind:'json',status:409,obj:{ok:false,message:cut(e)},headers:{'cache-control':'no-store'}};}}
    }return old.route.call(this,deps,input);}
    const json=(obj,status=200)=>({kind:'json',obj,status,headers:{'cache-control':'no-store'}});
    const who=deps.requirePet(input.url.searchParams,()=>deps.readConfig());if(!who.ok)return who.res;
    const id=who.petId;this.bind(id,{...deps,humanity:()=>deps.humanityStore.snapshot(id)});
    try{
      if(input.method==='POST'){
        const o=JSON.parse(input.body||'{}');if(!o||typeof o!=='object'||Array.isArray(o))throw Error('请求无效');
        if(o.action==='worksite'){if(typeof o.open!=='boolean')throw Error('工地状态无效');this.laborWorksite(id,o.key,o.open);return json({ok:true,labor:this.laborSnapshot(id)});}
        if(o.action==='offer' && o.surface!==undefined&&!['web','desktop'].includes(o.surface))throw Error('搬砖工地只能在软件页面内');
        if(o.action==='offer')o.assetRoot=who.pet.assetRoot||id;
        // Retry of the final payment must be a no-op even after the contract closes.
        const paid=ledger(this.store.read(id)).contracts.find(c=>c.id===o.id&&c.status==='paid');
        if(!(o.action==='pay'&&paid?.payments.some(x=>x.key===o.key)))this.laborAction(id,o);
      }else if(input.method!=='GET')return json({ok:false,message:'请使用 GET 或 POST'},405);
      this.advanceLabor(id);return json({ok:true,labor:{...this.laborSnapshot(id),error:ledger(this.store.read(id)).error||null}});
    }catch(e){return json({ok:false,message:cut(e)},400);}
  };
  Runtime.prototype.dispose=function(){this.laborPages?.clear();for(const controller of this.laborControllers?.values()||[])controller.abort();return old.dispose.call(this);};
}
