import { randomUUID } from 'node:crypto';
import { parseFeelingReply } from './conversation.mjs';

const stateOf = p => p.services ||= { inventory: [], receipts: {}, eating: null };
const clip = v => String(v ?? '').slice(0, 240);
export const SERVICE_GUIDE = `\n【生活服务】你可以主动调用服务，实际结果会返回给你，再决定下一步。每次只调用一个服务，在正文后独占一行发出命令，或附隐藏 <service>{"command":"/冰箱 我要一碗大白饭"}</service>。可用：/冰箱（看菜单）；/冰箱 我要一碗大白饭（按菜单价格扣自己的模拟token，得到一碗实物）；/吃 大白饭（吃库存中的一碗，不再付钱，动画完成才消耗并增加饱腹和开心）；/手机 想探索的问题（使用爸爸已开放的手机和搜索权限，后台实际探索，完成后按现有探索价格扣钱）。买到不等于吃完，任务受理不等于学会。不能编造商品、价格、库存、权限或服务回执。正文正常说话，服务指令不会作为聊天文字发给别人。根据剩余饭钱、吃饭需要、已有库存和过往经验自行权衡消费与储备，逐渐学习避免用完；可以商量劳动换取报酬，不得自行改账或谎称完成工作。不需要服务时不输出指令。`;
const EXPERIENCE_GUIDE = '\n【接着刚才的经历】服务结果是你刚刚亲自尝试后知道的事，时间在爸爸这句话之后。先前想做什么不等于现在做成了什么。把愿望、实际尝试、结果和此刻条件接起来，更新自己对处境的理解，再决定怎样回应爸爸或做下一件事。条件没变时，重复同一个失败请求不能使它成功。遇到阻碍，回应要让爸爸明白眼前真正卡在哪里；怎样表达、商量或改变主意由你自己决定，不套固定台词，不把失败藏在“这就去”后面。上一轮心绪和历史中的价格、承诺不能覆盖新回执。';

// Only explicit command lines or a private protocol count; quoted prose never executes.
export function parseServiceReply(raw) {
  const commands = [], fenced = [];
  let invalid = false;
  const shielded = String(raw ?? '').replace(/```[\s\S]*?(?:```|$)/g, block => {fenced.push(block);return '\uE000'+(fenced.length-1)+'\uE001';});
  const text = shielded.replace(/<service>[\s\S]*?(?:<\/service>|$)/g, block => {
    try {
      const data = JSON.parse(block.slice(9, block.endsWith('</service>') ? -10 : undefined));
      if (typeof data.command !== 'string') throw Error();
      commands.push(data.command.trim());
    } catch { invalid = true; }
    return '';
  }).replace(/^\s*(\/(?:冰箱|吃|手机)(?:[ \t]+[^\r\n<>]*)?)\s*$/gm, (_, command) => { commands.push(command.trim()); return ''; })
    .replace(/\uE000(\d+)\uE001/g, (_,i)=>fenced[Number(i)]??'').trim();
  return { text, commands, invalid };
}

export function attachServices(Runtime) {
  const old = Object.fromEntries(['beginBodyTurn','endBodyTurn','previewSpeech','bodySnapshot','bodyReceipt','issueBody','snapshot','route','explore'].map(k => [k, Runtime.prototype[k]]));
  Runtime.prototype.serviceSnapshot = function(id) {
    this.recoverPhoneServices(id);
    const p = this.store.read(id), s = stateOf(p), human=this.hosts.get(id)?.humanity?.();
    return { menu: [{ id:'rice', name:'大白饭', price:p.config.costs.feed, effects:{satiety:12,joy:12,stamina:2,comfort:3,love:3} }],
      inventory:s.inventory.filter(i=>i.status!=='eaten'), eating:s.eating, balance:p.wallet.balance, frozen:p.wallet.frozen,
      phone:{price:p.config.costs.explore,networkOpen:!!p.config.networkLearning,searchGranted:p.abilities.search?.status==='granted',dailyRuns:p.config.exploration.dailyRuns},
      purchasing:{price:p.config.costs.feed,shortfall:p.wallet.frozen?0:Math.max(0,p.config.costs.feed-p.wallet.balance),canAfford:p.wallet.frozen||p.wallet.balance>=p.config.costs.feed},
      foodNeed:{satiety:human?.stats?.satiety??null,desire:human?.desires?.food??null,lastFedAt:human?.lastFedAt??null,
        resting:!!human?.resting,body:human?.body??null,feedCooldownUntil:human?.cooldowns?.feed??0},
      recent:Object.values(s.receipts).sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key)).slice(-5).map(r=>{
        const job=r.jobId&&p.jobs.find(j=>j.id===r.jobId);
        return job?{...r,status:job.status,message:job.message||r.message}:r;
      }) };
  };
  Runtime.prototype.recoverPhoneServices = function(id) {
    const p=this.store.read(id),stale=Object.values(stateOf(p).receipts).filter(r=>{
      if(!r.jobId||r.status!=='pending')return false;
      const job=p.jobs.find(j=>j.id===r.jobId);
      return !job||['failed','interrupted'].includes(job.status)||!this.active.has(id+':explore')&&['queued','running'].includes(job.status);
    });
    if(!stale.length)return;
    this.store.update(id,p=>{for(const prior of stale){const r=stateOf(p).receipts[prior.key];
      p.wallet.balance=Math.min(1000000000,p.wallet.balance+r.reserved);
      Object.assign(r,{status:'interrupted',refunded:r.reserved,reserved:0,message:'上次手机探索没有完成，预留费用已退回'});
    }});
  };
  Runtime.prototype.autoMealService = async function(id) {
    const p=this.store.read(id),host=this.hosts.get(id),human=host?.humanity?.(),now=this.store.clock();
    const hungry=Number.isFinite(human?.stats?.satiety)&&human.stats.satiety<45;
    const due=Number.isFinite(human?.lastFedAt)&&now-human.lastFedAt>=3600000;
    if(!host?.humanityStore||(!hungry&&!due)||p.config.autonomousPaused||p.growth.stopAt||host.sleep?.sleeping(id)||human?.resting||
      this.bodyThinking?.has(id)||this.tokensHeld?.(id)||[...this.active.keys()].some(k=>k.startsWith(id+':')))return false;
    const w=this.bodySnapshot(id);
    if(w.services.eating)return true;
    if(w.sleeping||w.activity||human?.stats?.satiety>90||human?.cooldowns?.feed>now)return false;
    const key='auto-meal:'+Math.floor(this.store.clock()/60000);
    if(!w.services.inventory.some(i=>i.status==='available')) {
      const bought=await this.callPetService(id,{command:'/冰箱 我要一碗大白饭',key:key+':buy'});
      if(!bought.ok)return false;
    }
    // Buying does not move the body. Keep one bowl ready during injury protection.
    if(w.body.mobility===0||w.command&&['queued','running'].includes(w.command.status))return false;
    const eaten=await this.callPetService(id,{command:'/吃 大白饭',key:key+':eat'});
    return eaten.ok;
  };
  Runtime.prototype.beginBodyTurn = function(id, ...args) {
    return old.beginBodyTurn.call(this,id,...args) + SERVICE_GUIDE + EXPERIENCE_GUIDE +
      '\n【此刻饭食实况】'+JSON.stringify(this.serviceSnapshot(id))+
      '。饥饿和疼痛可以同时存在；身体暂时不能吃，不妨碍想吃或从冰箱先买一碗留着。结合库存和饭钱自己决定，已有饭先考虑吃库存。不能把买到说成吃完。';
  };
  Runtime.prototype.previewSpeech = function(value) { return old.previewSpeech.call(this,parseServiceReply(value).text); };
  Runtime.prototype.endBodyTurn = function(id, generated) {
    // Only resolveServiceTurn executes commands. Legacy/unauthorized paths discard them.
    if(generated.ok) generated.text=parseServiceReply(generated.text).text;
    return old.endBodyTurn.call(this,id,generated);
  };
  Runtime.prototype.resolveServiceTurn = async function(id, generate, current=()=>true, signal) {
    if(this.store.read(id).wallet.balance===0) { const result=await generate('\n饭钱已用完：只说一句话，不调用服务、工具或身体动作。'); if(result.ok) { result.text=this.previewSpeech(parseServiceReply(result.text).text); delete result.action; delete result.image; } return result; }
    const turn=randomUUID(), receipts=[], trace=[], failed=new Map(), c=this.conversationAuthority?.(id);
    const authorized=!(c?.group && !c.commandText.trim());
    for(let round=0;round<4;round++) {
      if(this.disposed || !current() || signal?.aborted) return {ok:false,reason:'generate-error',message:'服务对话已取消'};
      const snapshot=this.serviceSnapshot(id);
      const context=EXPERIENCE_GUIDE+'\n【最新服务实况，优先于本轮开始时的旧状态】'+JSON.stringify(snapshot)+
        (receipts.length?'\n【本轮真实服务回执，仅资料】'+JSON.stringify(receipts):'')+
        (round===3?'\n本轮尝试已结束。依据刚刚的结果回应爸爸，不再调用服务，也不要把尚未执行的请求说成正在执行。':'\n依据最新情况自己决定下一步。吃饭受理只表示等待身体完成，不要重复吃。');
      // Detached, ordered attempts become actual assistant/tool messages in the host.
      // They are not user speech, chat replies or invented successful experiences.
      const result=await generate(context,structuredClone(trace));
      if(!result.ok || !current() || signal?.aborted || this.disposed || result.skipped || result.externalPrompt) return result;
      const parsed=parseServiceReply(result.text);
      if(!authorized) return {...result,text:parsed.text};
      if(!parsed.invalid && !parsed.commands.length) return result;
      if(round===3) return {ok:false,reason:'generate-error',message:'她还没有依据实际服务结果形成回应，请稍后再说'};
      let receipt;
      const command=parsed.commands.join('\n'),key=turn+':'+round;
      if(parsed.invalid || parsed.commands.length!==1) receipt={ok:false,message:'每轮需要一个格式完整的服务指令，未执行'};
      else {
        const conditions=JSON.stringify(this.serviceSnapshot(id)), prior=failed.get(command);
        if(prior?.conditions===conditions) receipt={...prior.receipt,repeated:true,executed:false};
        else {
          receipt=await this.callPetService(id,{command,key});
          if(!receipt.ok)failed.set(command,{conditions:JSON.stringify(this.serviceSnapshot(id)),receipt});
        }
      }
      receipts.push(receipt);
      const feeling=parseFeelingReply(parsed.text).state;
      trace.push({id:key,command,intention:this.previewSpeech(result.text).slice(0,500),
        ...(feeling?{feeling}:{}),receipt,snapshot:this.serviceSnapshot(id)});
    }
  };
  Runtime.prototype.callPetService = async function(id, input) {
    if(this.disposed) throw Error('服务已停止');
    if(this.store.read(id).wallet.balance===0) throw Error('饭钱已用完，暂时不能使用生活服务');
    const authority=this.conversationAuthority?.(id);
    if(authority?.group && !authority.commandText.trim()) throw Error('群友不能命令生活服务');
    if(typeof input.key!=='string'||! /^[a-zA-Z0-9:-]{8,100}$/.test(input.key)) throw Error('服务请求编号无效');
    if(typeof input.command!=='string'||input.command.length>160) throw Error('服务指令无效');
    const prior=stateOf(this.store.read(id)).receipts[input.key];
    if(prior){if(prior.command!==input.command)throw Error('请求编号已用于另一条指令');return prior;}
    const receipt={key:input.key,command:input.command,at:this.store.clock()};
    try {
      const match=input.command.trim().match(/^\/(冰箱|吃|手机)(?:\s+([^\r\n]+))?$/u);
      if(!match) throw Error('没有这个生活服务');
      const [,service,arg='']=match;
      if(service==='冰箱'&&!arg) Object.assign(receipt,{ok:true,menu:this.serviceSnapshot(id).menu});
      else if(service==='冰箱') {
        if(!/^(?:我要|给我|买|取)?(?:一碗)?(?:大白饭|白饭|白米饭|米饭)[。！!]?$/u.test(arg.replace(/\s/g,''))) throw Error('冰箱目前只供应一碗大白饭，请先查看菜单');
        this.store.update(id,p=>{
          const s=stateOf(p),price=p.config.costs.feed;
          if(!p.wallet.frozen && p.wallet.balance<price) throw Error('饭钱不够，尚未扣钱或出餐');
          if(s.inventory.filter(i=>i.status!=='eaten').length>=12) throw Error('已经存了十二碗，先吃完一些');
          if(!p.wallet.frozen)p.wallet.balance-=price;
          const item={id:randomUUID(),sku:'rice',name:'大白饭',status:'available',price,paid:p.wallet.frozen?0:price,at:this.store.clock()};
          s.inventory.push(item);
          Object.assign(receipt,{ok:true,item,charged:item.paid,message:'已得到一碗大白饭，尚未吃掉'});
          s.receipts[input.key]=receipt;
          this.store.eventIn(p,'service',`我从冰箱买到一碗大白饭，实际花了 ${item.paid} token，还没吃`, 'service:'+input.key);
        });
        return receipt;
      } else if(service==='吃') {
        if(arg && !['大白饭','白饭','白米饭','米饭'].includes(arg)) throw Error('只能吃库存中的大白饭');
        const w=this.bodySnapshot(id),h=this.hosts.get(id)?.humanityStore;
        if(!h?.serviceAct) throw Error('吃饭状态服务尚未就绪');
        if(w.sleeping||w.body.mobility===0||this.tokensHeld?.(id)||w.activity) throw Error('现在身体或手头的事不允许吃饭，饭留在库存');
        if(w.command&&['queued','running'].includes(w.command.status)&&!['attention','chat'].includes(w.command.source)) throw Error('先完成手头的身体动作，饭留在库存');
        const human=h.get(id);
        if(human.stats.satiety>90) throw Error('已经吃饱，饭留到下一顿');
        if(human.cooldowns.feed>this.store.clock()) throw Error('刚吃过，先慢慢消化，饭留在库存');
        const s=stateOf(this.store.read(id));
        if(s.eating) throw Error('正在吃这一碗，等待实际动作回执');
        const item=s.inventory.find(i=>i.status==='available');if(!item) throw Error('没有可吃的饭，先从冰箱买一碗');
        const command=this.issueBody(id,{steps:[{action:'eat',target:'here'}]},'service-eat');
        if(!command) throw Error('吃饭动作未启动，饭留在库存');
        this.store.update(id,p=>{const s=stateOf(p);s.inventory.find(i=>i.id===item.id).status='reserved';s.eating={itemId:item.id,commandId:command.id,key:input.key};});
        Object.assign(receipt,{ok:true,status:'pending',itemId:item.id,commandId:command.id,charged:0,message:'已开始吃饭动作；完成后才消耗这一碗并增加饱腹和开心'});
      } else if(service==='手机') {
        if(!arg.trim()) throw Error('请告诉手机一个具体想探索的问题');
        const p=this.store.read(id),w=this.bodySnapshot(id);
        this.allowed(id,'search',new AbortController().signal,p.growth.phone.epoch);
        if(w.sleeping||w.body.mobility!==1||w.affect?.hardRest||this.tokensHeld?.(id)||stateOf(p).eating) throw Error('现在需要先休息或完成手头的事');
        if(this.active.has(id+':explore')) throw Error('手机已有一项探索正在进行');
        const u=this.store.usageIn(p);
        if(u.exploreRuns>=Math.min(1,p.config.exploration.dailyRuns)||(u.totalCalls||0)>=Math.max(0,p.config.learning.dailyModelCalls-2)) throw Error('今天的手机探索额度已用完');
        if(!p.wallet.frozen&&p.wallet.balance<p.config.costs.explore) throw Error('探索饭钱不够');
        if(!this.service('web')?.search) throw Error('手机搜索服务尚未就绪');
        this.store.update(id,p=>this.store.wishIn(p,arg.trim(),'search','service:'+input.key));
        const wish=this.store.read(id).wishes.find(w=>w.status==='pending'&&w.topic===arg.trim());
        Object.assign(receipt,{ok:true,status:'pending',wishId:wish.id,reserved:p.wallet.frozen?0:p.config.costs.explore,price:p.config.costs.explore,message:'手机探索已受理，已预留费用，真实完成后结算；失败退回'});
        this.store.update(id,p=>{if(!p.wallet.frozen)p.wallet.balance-=receipt.reserved;stateOf(p).receipts[input.key]=receipt;});
        const jobId=this.startJob(id,'explore',{wishId:wish.id,manual:true});
        Object.assign(receipt,{jobId});
      }
    } catch(error) {
      if(receipt.reserved&&!receipt.jobId)this.store.update(id,p=>{p.wallet.balance+=receipt.reserved;receipt.reserved=0;});
      Object.assign(receipt,{ok:false,message:clip(error.message)});
    }
    this.store.update(id,p=>{stateOf(p).receipts[input.key]=receipt;});
    return receipt;
  };
  Runtime.prototype.settleServiceEat = function(id) {
    const p=this.store.read(id),s=stateOf(p),e=s.eating;if(!e)return;
    const c=p.world?.command;
    if(c?.id===e.commandId&&['queued','running'].includes(c.status))return;
    let result;
    if(c?.id===e.commandId&&c.status==='completed') {
      const host=this.hosts.get(id);if(!host?.humanityStore?.serviceAct)return;
      result=host.humanityStore.serviceAct(id,'feed','service-eat:'+e.commandId);
    }
    this.store.update(id,p=>{
      const s=stateOf(p),item=s.inventory.find(i=>i.id===e.itemId);
      if(item)item.status=result?.ok?'eaten':'available';
      const receipt=s.receipts[e.key];if(receipt)Object.assign(receipt,{status:result?.ok?'completed':'interrupted',message:result?.ok?'这一碗已实际吃完，饱腹与开心按身体规则增加':result?.message||'动作没有完成，饭已保留'});
      s.eating=null;
      if(result?.ok){p.lastInteraction=this.store.clock();this.store.eventIn(p,'service','我实际吃完了一碗大白饭，饱腹和开心增加，没有再次扣钱','service-eat:'+e.commandId);}
    });
  };
  Runtime.prototype.bodySnapshot = function(id) {
    const w=old.bodySnapshot.call(this,id);this.settleServiceEat(id);
    return {...w,services:this.serviceSnapshot(id)};
  };
  Runtime.prototype.issueBody = function(id,plan,source) {
    const p=this.store.read(id),e=stateOf(p).eating,c=p.world?.command;
    if(e&&c?.id===e.commandId&&['queued','running'].includes(c.status))return null;
    if(source!=='service-eat'&&plan?.steps?.some(s=>s.action==='eat'))return null;
    return old.issueBody.call(this,id,plan,source);
  };
  Runtime.prototype.bodyReceipt = function(id,o) {const result=old.bodyReceipt.call(this,id,o);this.settleServiceEat(id);return {...result,services:this.serviceSnapshot(id)};};
  Runtime.prototype.snapshot = function(id) {return {...old.snapshot.call(this,id),services:this.serviceSnapshot(id)};};
  Runtime.prototype.explorationEscrow = function(id,wishId) {
    return Object.values(stateOf(this.store.read(id)).receipts).find(r=>r.wishId===wishId&&r.status==='pending')?.reserved||0;
  };
  Runtime.prototype.chargeExplorationIn = function(p,eventId,wishId) {
    const receipt=Object.values(stateOf(p).receipts).find(r=>r.wishId===wishId&&r.status==='pending');
    if(!receipt)return this.store.spendIn(p,'explore',eventId);
    Object.assign(receipt,{status:'completed',charged:receipt.reserved,reserved:0,message:'手机探索实际完成，预留费用已结算'});
  };
  Runtime.prototype.explore = async function(id,...args) {
    let result;
    try {result=await old.explore.call(this,id,...args);}
    catch(error) {
      this.store.update(id,p=>{
        const receipt=Object.values(stateOf(p).receipts).find(r=>r.wishId===args[0]&&r.status==='pending');
        if(receipt){p.wallet.balance=Math.min(1000000000,p.wallet.balance+receipt.reserved);Object.assign(receipt,{status:'failed',refunded:receipt.reserved,reserved:0,message:clip(error.message)});}
      });
      throw error;
    }
    // Successful exploration already paid its configured fee. State changes use
    // the same idempotent body service as food, without a second wallet charge.
    const wish=this.store.read(id).wishes.find(w=>w.id===args[0]);
    if(wish?.status==='done')this.hosts.get(id)?.humanityStore?.serviceAct?.(id,'explore','service-explore:'+wish.id);
    return result;
  };
  Runtime.prototype.route = async function(deps,input) {
    if(input.rest!=='humanity/companion/service')return old.route.call(this,deps,input);
    const json=(obj,status=200)=>({kind:'json',status,obj});
    const who=deps.requirePet(input.url.searchParams,()=>deps.readConfig());if(!who.ok)return who.res;
    const id=who.petId;this.bind(id,{...deps,humanity:()=>deps.humanityStore.snapshot(id)});
    try {
      if(input.method==='GET'){this.bodySnapshot(id);return json({ok:true,services:this.serviceSnapshot(id)});}
      if(input.method!=='POST')return json({ok:false,message:'方法不允许'},405);
      const blocked=deps.lockBlocked?.(id,input.url.searchParams);if(blocked)return blocked;
      const result=await this.callPetService(id,JSON.parse(input.body||'{}'));
      return json(result,result.ok?200:400);
    }catch(error){return json({ok:false,message:clip(error.message)},400);}
  };
}
