import { randomUUID } from 'node:crypto';

// This changes expression, never identity, physical damage, money or permissions.
export const SOFT_STYLE = '【相处的分寸】保留现有身份、关系和真实经历。撒泼可以有赖劲和小歪理，仍让人愿意亲近；具体说什么、要不要闹，由你此刻的心思决定。小剧场只是一起玩的设定，实际受伤与恢复仍以身体事实为准。';
const choice = (id, label, event, care) => ({ id, label, event, ...(care ? { care } : {}) });
export const SOFT_SCENES = Object.freeze({
  bowl: { label:'抱碗等一口', pose:'sulk_bowl', cue:'抱碗坐下，低头往上看，拿一口白饭讨价还价；没有投喂就不能说吃到了', choices:[choice('feed','添一点饭','爸爸实际添了一点饭','feed'),choice('ask','问问吃了几碗','爸爸问刚才吃了几碗；只依据真实记录，不编造吃饭次数')] },
  caught: { label:'偷吃被发现', pose:'sulk_bowl', cue:'爸爸邀你演偷吃被抓的小剧场；心虚地藏碗、用小歪理耍赖。这是游戏设定，不能记成真的偷吃过', choices:[choice('point','指指嘴边','爸爸在小剧场里指出嘴边的饭粒，你露馅了'),choice('wipe','擦擦嘴角','爸爸在小剧场里替你擦嘴角；软软地求再尝一口')] },
  blanket: { label:'被窝里耍赖', pose:'sulk_blanket', cue:'裹着小毯子不想起来，露一只眼睛偷看，商量再赖一小会儿；这是清醒时玩耍，不改变真实睡眠作息', choices:[choice('peek','掀开一小角','爸爸掀开毯子一小角，你又缩进去偷看'),choice('tuck','再躺一会儿','爸爸答应让你在小毯子里再赖一会儿')] },
  slack: { label:'摸鱼被抓包', pose:'sulk_blanket', cue:'爸爸邀你演摸鱼被抓的小剧场，借口还没想好就先心虚承认一点点；不虚构真的玩过什么游戏', choices:[choice('last','陪她玩一会儿','爸爸在小剧场里愿意陪你玩一会儿'),choice('tidy','让她自己收好','爸爸让你在小剧场里收好玩具，你慢吞吞答应还想讨个摸头')] },
  tail: { label:'小尾巴露馅', pose:'coax', cue:'还想装一小会儿委屈，尾巴已经先高兴，忍不住凑近等摸头', choices:[choice('pet','摸摸头','爸爸实际摸了摸头','pet'),choice('tease','你尾巴在摇哦','爸爸看穿了你偷偷高兴，你有点害羞地按住尾巴')] },
  sorry: { label:'递张和好纸条', pose:'coax', cue:'爸爸邀你演递和好纸条的小剧场，纸条上申请坐近一点；没有真实过错就不编造闯过什么祸', choices:[choice('accept','收下小纸条','爸爸在小剧场里收下和好纸条'),choice('hand','朝她伸出手','爸爸在小剧场里伸出手让你靠近')] },
});
const poseScene = { sulk_bowl:'bowl', sulk_blanket:'blanket', coax:'tail', tantrum:'bowl', protest:'blanket' };
const cut = value => String(value?.message ?? value ?? '').slice(0,300);
export function attachSoftTantrum(Runtime) {
  const proto=Runtime.prototype, old=Object.fromEntries(['prompt','bodySnapshot','issueBody','beginBodyTurn','care','route','dispose'].map(k=>[k,proto[k]]));
  const sessions = rt => rt.softSessions ||= new Map();
  proto.softSnapshot=function(id) {
    const current=sessions(this).get(id), h=this.hosts.get(id);
    const state=h?.humanity?.();
    if(current && (current.expires<=this.store.clock() || h?.sleep?.sleeping(id) || state?.resting || state?.body?.mobility<1))sessions(this).delete(id);
    const s=sessions(this).get(id);
    return { scenes:Object.entries(SOFT_SCENES).map(([id,s])=>({id,label:s.label,pose:s.pose})), current:s?structuredClone(s):null };
  };
  proto.prompt=function(id){
    const s=this.softSnapshot(id).current;
    return old.prompt.call(this,id)+'\n'+SOFT_STYLE+(s?'\n【眼前的小脾气】'+SOFT_SCENES[s.scene].cue+'；当前阶段：'+s.status+'。这段提示是情境，不是已经完成的动作或说过的话。':'');
  };
  proto.bodySnapshot=function(id){return {...old.bodySnapshot.call(this,id),soft:this.softSnapshot(id)};};
  proto.issueBody=function(id,plan,source){
    const result=old.issueBody.call(this,id,plan,source);
    const scene=plan?.steps?.map(s=>poseScene[s.action]).find(Boolean),current=this.softSnapshot(id).current;
    if(result && !scene && plan?.steps?.some(s=>['walk','approach','play','slack','lift','putdown','learn'].includes(s.action)))sessions(this).delete(id);
    if(result && scene && !current && source!=='curiosity' && source!=='labor' && source!=='labor-mood') {
      const def=SOFT_SCENES[scene];sessions(this).set(id,{id:randomUUID(),scene,pose:def.pose,status:'waiting',expires:this.store.clock()+60000,choices:def.choices.map(({id,label})=>({id,label}))});
    }
    return result;
  };
  proto.beginBodyTurn=function(id,text,isEvent){
    if(!isEvent && /^(?:先)?(?:停止|别烦(?:我)?|别闹(?:了)?|安静(?:一点)?|别撒泼(?:了)?)[！!。\s]*$/.test(String(text).trim())) {
      sessions(this).delete(id);
      this.store.update(id,p=>{const c=p.world?.command;if(c && ['queued','running'].includes(c.status) && c.steps.some(s=>poseScene[s.action]))c.status='interrupted';});
    }
    return old.beginBodyTurn.call(this,id,text,isEvent)+'\n可用姿态：sulk_bowl 抱碗坐地，sulk_blanket 裹被，coax 伸手讨哄；自己按此刻心思选择，也可以选其他动作。';
  };
  proto.care=function(id,action,...args){
    if(['collision','utensil','knock','rest','wake'].includes(action))sessions(this).delete(id);
    else if(['feed','pet','soothe'].includes(action)){
      const s=sessions(this).get(id);if(s && s.status==='waiting'){s.status='settled';s.pose='coax';s.choices=[];s.expires=this.store.clock()+8000;}
    }
    return old.care.call(this,id,action,...args);
  };
  proto.route=async function(deps,input){
    if(input.rest!=='humanity/companion/soft')return old.route.call(this,deps,input);
    const json=(obj,status=200)=>({kind:'json',status,obj,headers:{'cache-control':'no-store'}});
    const who=deps.requirePet(input.url.searchParams,()=>deps.readConfig());if(!who.ok)return who.res;
    const id=who.petId;this.bind(id,{...deps,humanity:()=>deps.humanityStore.snapshot(id)});
    if(input.method==='GET')return json({ok:true,soft:this.softSnapshot(id)});
    if(input.method!=='POST')return json({ok:false,message:'请使用 GET 或 POST'},405);
    try {
      const o=JSON.parse(input.body||'{}');if(!o||Array.isArray(o)||typeof o!=='object')throw Error('请求格式不正确');
      const blocked=deps.lockBlocked?.(id,input.url.searchParams);if(blocked)return blocked;
      const current=this.softSnapshot(id).current;
      if(o.action==='dismiss'){
        if(current && o.id!==current.id)throw Error('这段小脾气已经换了，看看现在的她吧');
        sessions(this).delete(id);this.store.update(id,p=>{const c=p.world?.command;if(c&&c.steps.some(s=>poseScene[s.action])&&['queued','running'].includes(c.status))c.status='interrupted';});
        return json({ok:true,soft:this.softSnapshot(id)});
      }
      if(this.softBusy?.has(id))return json({ok:false,message:'她正在回应刚才的互动，等一下再接话'},409);
      let event,session;
      if(o.action==='start'){
        if(!Object.hasOwn(SOFT_SCENES,o.scene))throw Error('没有这个小剧场');
        const w=this.bodySnapshot(id);
        if(w.sleeping||w.body.mobility<1||w.activity||w.labor?.current?.status==='working')throw Error('她正在睡觉、恢复、学习或干活，等歇下来再玩');
        const def=SOFT_SCENES[o.scene];
        session={id:randomUUID(),scene:o.scene,pose:def.pose,status:'waiting',expires:this.store.clock()+60000,choices:def.choices.map(({id,label})=>({id,label}))};
        sessions(this).set(id,session);
        this.issueBody(id,{steps:[{action:def.pose}]},'soft-choice');
        event='爸爸主动和你玩“'+def.label+'”小剧场：'+def.cue+'。只说此刻的话，不虚构已经发生过的偷吃、摸鱼或犯错。';
      } else if(o.action==='choose') {
        if(!current||current.id!==o.id||current.status!=='waiting')throw Error('这段小脾气已经结束，看看现在的她吧');
        const selected=SOFT_SCENES[current.scene].choices.find(c=>c.id===o.choice);if(!selected)throw Error('没有这个回应');
        // Use the same authoritative care store, cooldowns, spending and animation
        // path as the original care route; a button never invents a feeding.
        if(selected.care){
          const result=deps.humanityStore.act(id,selected.care);if(!result.ok)return json(result,409);
          this.care(id,selected.care,result.state.memories[0]?.text||selected.care,result.state.memories[0]?.ts);
          if(selected.care==='feed'){
            const name=who.conf?.animations?.baifan?.[3];
            if(name){const record=deps.playback.create(id,name);deps.state.writePet(id,'anim',{name,playbackId:record.playbackId});}
          }
        }
        session=sessions(this).get(id);if(!session)throw Error('她现在需要休息，稍后再玩');
        session.status='settled';session.choice=selected.id;session.pose=selected.id==='tuck'?'sulk_blanket':'coax';session.choices=[];session.expires=this.store.clock()+10000;
        this.store.record(id,'play','爸爸在“'+SOFT_SCENES[session.scene].label+'”小剧场选择：'+selected.label,'soft:'+session.id+':'+selected.id,{scene:session.scene,choice:selected.id,roleplay:!selected.care});
        this.issueBody(id,{steps:[{action:session.pose}]},'soft-choice');event=selected.event+'。结合刚才的小脾气自然接一句，允许一点得寸进尺；不能复读上一句。';
      }else throw Error('未知互动');
      this.softBusy ||= new Set();this.softBusy.add(id);
      let reaction;
      try{reaction={ok:true,text:await this.reactToEvent(id,event+'\n'+SOFT_STYLE)};}
      catch(e){reaction={ok:false,message:cut(e)};}
      finally{this.softBusy.delete(id);}
      return json({ok:true,soft:this.softSnapshot(id),reaction});
    }catch(e){return json({ok:false,message:cut(e)},400);}
  };
  proto.dispose=function(){this.softSessions?.clear();return old.dispose.call(this);};
}
