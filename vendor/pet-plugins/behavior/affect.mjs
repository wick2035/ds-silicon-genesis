// One interpretation of the live state for speech, model decisions and the body.
// This module never changes feelings, spends money, feeds, sleeps or calls a model.
import { validateBodyPlan } from './embodiment.mjs';

const clamp = (n, fallback = 0) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : fallback));
const modes = {
  pain: ['身体还疼', '说话短一点，可以停顿或小声说疼；继续回应爸爸这句话，不夸张哭喊，不假装已经痊愈', 'rest'],
  tired: ['疲倦想缓缓', '语句短、反应慢一点，少主动开启话题，可以商量歇一下；困倦不抹掉刚才的委屈、饭钱或约定，继续接话，不每次都以睡觉收尾', 'rest'],
  fear: ['不安，想确认安全', '先确认眼前发生的事，语气迟疑、轻一点；受安抚后才慢慢放松，不立刻兴奋扑过去', 'listen'],
  anger: ['有点气鼓鼓', '保留小不满和自己的理由，可以小声抗议、讲条件；不因为一句普通聊天立刻变开心', 'protest'],
  sadness: ['委屈，没那么有精神', '说得轻、少一点，可以想被陪着；不是每句都哭，仍认真回答具体问题', 'rest'],
  aversion: ['有点抗拒', '温和表达不喜欢或想停一下，身体先收一收；不攻击爸爸，不假装很享受', 'protest'],
  joy: ['高兴，想分享', '语气更明亮、接话更主动，可以有一点孩子气的兴奋；不机械重复撒娇', 'happy'],
  love: ['亲近、心里软下来', '语气亲昵而放松，可以想坐近一点或回应关心；喜欢爸爸也可以同时疼、怕或委屈', 'shy'],
  longing: ['心里惦记着什么', '结合真实的小念想和这次话题表达期待；没有真实目标就别凭空编造承诺或需求', 'look'],
  food: ['饿了，惦记一口饭', '可以分心想到饭、轻轻商量吃一点；先回答当前话题，不每轮讨饭，没投喂就没吃到', 'beg'],
  rest: ['困意上来了', '语句短、节奏慢，可以商量休息；仍接住爸爸正在说的事情，不因困倦突然不在乎；没有实际睡眠开关就不能说已经睡着', 'rest'],
  company: ['想有人陪着', '更在意爸爸的回应，可以轻轻问能否待在旁边；不指责正常忙碌、不制造离开压力', 'shy'],
  curiosity: ['想看一看、弄明白', '围绕当前话题提出一个具体小问题，愿意观察和琢磨；没有权限就不能声称联网查过', 'look'],
  play: ['有了点玩心', '可以自然提议一个小玩法，动作更轻快；爸爸在认真说事时先听完', 'play'],
  comfort: ['想待得舒服一点', '轻声表达想放稳、想安静或想被照料；照料后慢慢缓和，不夸大身体痛苦', 'rest'],
  calm: ['自在、平稳', '按原有性格自然接话，让状态藏在语气里，不强行卖萌或表演情绪', 'listen'],
};

export function deriveAffect(h = {}) {
  const b=h.stats || {}, e=h.emotions || {}, d=h.desires || {};
  const pain=clamp(b.pain), energy=clamp(b.energy,80), stamina=clamp(b.stamina,84);
  const emotions=Object.fromEntries(Object.keys({joy:0,anger:0,sadness:0,fear:0,love:0,aversion:0,longing:0}).map(k=>[k,clamp(e[k])]));
  const needs=Object.fromEntries(Object.keys({food:0,rest:0,company:0,curiosity:0,play:0,comfort:0}).map(k=>[k,clamp(d[k])]));
  const candidates=[];
  const add=(key,value,threshold,weight=1)=>{if(value>=threshold)candidates.push({key,value,score:(value-threshold+10)/(110-threshold)*weight});};
  for(const [key,threshold]of Object.entries({joy:65,anger:32,sadness:28,fear:30,love:74,aversion:28,longing:42}))add(key,emotions[key],threshold,key==='fear'?1.3:1);
  for(const [key,threshold]of Object.entries({food:45,rest:50,company:40,curiosity:55,play:50,comfort:45}))add(key,needs[key],threshold,.9);
  if(pain>=16)add('pain',pain,16,2.3);
  if(Math.min(energy,stamina)<40)add('tired',100-Math.min(energy,stamina),60,1.8);
  if(h.resting)add('rest',Math.max(70,needs.rest),50,1.8);
  candidates.sort((a,b)=>b.score-a.score);
  const primary=candidates[0]?.key || 'calm';
  const hardRest=energy<25 || stamina<25 || pain>35;
  const pace=Math.max(.55,Math.min(1.12,.72+Math.min(energy,stamina)*.004+(emotions.joy>70?.08:0)-pain*.003-emotions.fear*.0015));
  const roaming=hardRest?0:Math.max(.1,Math.min(1,(Math.min(energy,stamina)/85)*(1-emotions.fear/140)*(1-pain/90)));
  return {key:primary,label:modes[primary][0],guidance:modes[primary][1],idleAction:modes[primary][2],pace:+pace.toFixed(2),roaming:+roaming.toFixed(2),
    hardRest,pain,energy,stamina,emotions,needs,signals:candidates.slice(0,3).map(c=>({key:c.key,label:modes[c.key][0],value:c.value,guidance:modes[c.key][1]}))};
}

export function affectPrompt(a) {
  return '\n【身体与情感参考，0–100；不是台词或指定情绪】'+JSON.stringify({
    pain:a.pain,energy:a.energy,stamina:a.stamina,emotions:a.emotions,needs:a.needs,painTrend:a.trend || 'steady'
  })+'。身体会影响精力和实际能做的事；你怎样理解爸爸、此刻想要什么，由这一段相处决定。无需每轮提身体不适，继续回答眼前的话。'+
    (a.hardRest?'实际动作避免跑跳和玩耍；已约定的搬砖可以继续，不舒服时可请求休息。清醒且被松开后，掉落饭钱仍可低伏慢慢爬过去捡，余痛保留。':'实际动作遵守当前身体能力。')+
    '想吃、想睡、想玩不代表已经完成投喂、入睡或玩耍，实际行为以执行回执为准。';
}

export function adaptAffectPlan(plan, a, source='chat') {
  plan=validateBodyPlan(plan);
  if(source==='tokens'||source==='labor')return plan;
  const energetic=new Set(['walk','approach','play','slack','happy','pickup','lift','putdown']);
  const steps=plan.steps.map(step=>{
    let action=step.action;
    if(a.hardRest && energetic.has(action))action='rest';
    return {...step,action,...(action!==step.action?{target:'here'}:{})};
  });
  return {...plan,steps:steps.filter((step,i)=>i===0 || step.action!==steps[i-1].action || step.target!==steps[i-1].target)};
}

export function attachAffect(Runtime) {
  const proto=Runtime.prototype, old=Object.fromEntries(['prompt','beginBodyTurn','bodySnapshot','issueBody','bodyReceipt','bodyExplore','model','dispose'].map(k=>[k,proto[k]]));
  proto.affectSnapshot=function(id){
    const a=deriveAffect(this.hosts.get(id)?.humanity?.()), now=this.store.clock();
    this.affectHistory ||= new Map();const previous=this.affectHistory.get(id);
    if(!previous || now<previous.at || now-previous.at>=1000){
      const velocity=previous&&now>previous.at?(a.pain-previous.pain)*1000/(now-previous.at):0;
      a.trend=velocity>.15?'rising':velocity<-.15?'falling':'steady';
      this.affectHistory.set(id,{at:now,pain:a.pain,trend:a.trend});
    }else a.trend=previous.trend;
    return a;
  };
  proto.prompt=function(id){return old.prompt.call(this,id)+affectPrompt(this.affectSnapshot(id));};
  proto.beginBodyTurn=function(id,...args){
    const prompt=old.beginBodyTurn.call(this,id,...args);
    return prompt.includes('【身体与情感参考')?prompt:prompt+affectPrompt(this.affectSnapshot(id));
  };
  proto.model=function(id,kind,system,userText,...args){return old.model.call(this,id,kind,system,
    ['strategy','embody','help'].includes(kind)?userText+affectPrompt(this.affectSnapshot(id)):userText,...args);};
  proto.bodySnapshot=function(id){
    const world=old.bodySnapshot.call(this,id), affect=this.affectSnapshot(id), c=world.command;
    if(c&&!['tokens','labor'].includes(c.source)&&['queued','running'].includes(c.status)){
      const next=adaptAffectPlan({steps:[c.steps[c.index]]},affect,c.source);
      if(world.sleeping || world.body.mobility===0 || !next || next.steps[0].action!==c.steps[c.index].action){
        this.store.update(id,p=>{if(p.world?.command?.id===c.id)p.world.command.status='interrupted';});
        world.command={...c,status:'interrupted'};
      }
    }
    return {...world,affect};
  };
  proto.issueBody=function(id,plan,source='chat'){
    const affect=this.affectSnapshot(id), adjusted=adaptAffectPlan(plan,affect,source);
    if(!adjusted)return null;
    const command=old.issueBody.call(this,id,adjusted,source);
    if(command){
      command.affect={key:affect.key,pace:affect.pace};
      this.store.update(id,p=>{if(p.world?.command?.id===command.id)p.world.command.affect=command.affect;});
    }
    return command;
  };
  proto.bodyReceipt=function(id,o){
    const w=this.bodySnapshot(id),c=w.command;
    // Snapshot re-checks physical limits, even when a model reply or video was slow.
    if(c?.id===o.id && c.status==='interrupted')throw Error('身体状态已改变，原动作已中断');
    return old.bodyReceipt.call(this,id,o);
  };
  proto.bodyExplore=function(id){const a=this.affectSnapshot(id);if(a.hardRest||a.emotions.fear>=55)return;return old.bodyExplore.call(this,id);};
  proto.dispose=function(){this.affectHistory?.clear();return old.dispose.call(this);};
}
