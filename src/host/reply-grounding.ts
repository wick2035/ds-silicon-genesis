import type {CanonicalEnvelope} from '../storage/postgres.js';

// These categories describe observable actions, not feelings or ordinary speech.
// Only the action lifecycle can produce the linked, non-invalidated receipt.
const categories:Array<{words:RegExp;types:string[];activities?:string[];eventType?:string}>= [
  {words:/吃(?:饭|了|完|下|饱|过|到)/u,types:['service.eat-rice','care.feed']},
  {words:/喝(?:水|了|完|过|到)/u,types:['care.water']},
  {words:/(?:喂了我|喂过我|给我喂|被喂了)/u,types:['care.feed']},
  {words:/(?:摸了我|摸过我|被摸了)/u,types:['care.pet']},
  {words:/(?:买|取)(?:了|到|过|完|来|下)?(?:一碗|碗|份|点|些)?(?:白饭|大白饭|米饭|饭)/u,types:['service.buy-rice']},
  {words:/(?:睡着|睡了|睡过|入睡|睡觉)/u,types:['body.sleep']},
  {words:/(?:醒了|醒来|醒过来)/u,types:['body.wake']},
  {words:/(?:走路|散步|走动|走了|走过|跑步|跑了|跑过)/u,types:['body.activity'],activities:['walk','run']},
  {words:/(?:玩玩具|玩球|玩魔方|抛球|玩了|玩过)/u,types:['body.activity','care.play'],activities:['play','cube','juggle']},
  {words:/(?:跳舞|唱歌|哼歌|伸懒腰|吹泡泡|观察)/u,types:['body.activity'],activities:['dance','hum','stretch','bubble','look']},
  {words:/(?:捡|拾|拿回)(?:到了|了|到|起|回)?(?:钱|碎片|金币)/u,types:['token.pickup']},
  {words:/(?:搜索|搜了|查了|查过|查到|查找|看了网页|读了网页|上网|联网|看了视频)/u,types:['learning.observe']},
  {words:/(?:看了图片|看过图片|看到了图片|观察了图片)/u,types:['image.observe']},
  {words:/(?:收到|领到|拿到|给了我|给我|付了|支付了)(?:了|过)?(?:工资|工钱|薪水|报酬)/u,types:[],eventType:'social.labor.payment'},
];
const explicitAction=/(?:我|咱|自己|刚刚|刚才|刚|已经|正在|刚才|这就|马上|立刻|现在就)/u;
const completion=/(?:刚|已经|正在|一直在|还在|了|过|完|着|到了|起来)/u;
const future=/(?:想|打算|准备|希望|要不要|能不能|可以|如果|假如|等|以后|明天|下次|再说)/u;
const immediate=/(?:这就|马上|立刻|现在就)/u;
const negated=/(?:没(?:有)?|不曾|尚未|未曾|还没|不能|不会|别|不要|并非|没法)/u;

function evidence(envelope:CanonicalEnvelope,types:string[],activities:string[]|undefined,now:number,eventType?:string) {
  const life=envelope.life,valid=(id:string)=>!Object.hasOwn(life.invalidSources,id);
  const actions=(life.actions??[]).filter(a=>types.includes(a.actionType) && (a.sourceIds??[]).every(valid) && (!activities || a.actionType!=='body.activity' || activities.includes(String(a.parameters?.activity))));
  const completed=actions.some(a=>a.status==='COMPLETED' && (life.receipts??[]).some(r=>r.actionId===a.id && r.receiptId===a.receiptId && r.status==='COMPLETED' && valid(r.receiptId) && Number.isFinite(Date.parse(r.occurredAt)) && now-Date.parse(r.occurredAt)<=15*60*1000 && now>=Date.parse(r.occurredAt) && (life.events??[]).some(e=>e.type==='action.receipt' && e.causationId===r.receiptId && valid(e.eventId)))) || !!eventType && (life.events??[]).some(e=>e.type===eventType && e.source==='user' && valid(e.eventId) && typeof (e.payload as any)?.amount==='number' && (e.payload as any).amount>0 && now>=Date.parse(e.occurredAt) && now-Date.parse(e.occurredAt)<=15*60*1000);
  const pending=actions.some(a=>['PENDING','DISPATCHED'].includes(a.status));
  return {completed,pending};
}

/** Apply at the same commit as publication, using the newest authoritative state. */
export function groundActionReply(text:string,envelope:CanonicalEnvelope,now=Date.now()):string {
  return text.split(/(?<=[，,；;。！？!?\n])/u).map(sentence=>{
    if(!explicitAction.test(sentence) || negated.test(sentence))return sentence;
    const matched=categories.filter(c=>c.words.test(sentence));
    if(!matched.length)return sentence;
    if(future.test(sentence) && !immediate.test(sentence))return sentence;
    const intends=immediate.test(sentence) && !/(?:刚|已经|了|完)/u.test(sentence);
    if(!intends && !completion.test(sentence))return sentence;
    if(/(?:正在|一直在|还在)/u.test(sentence))return '这个动作现在是否正在执行还没有确认。';
    if(matched.every(c=>{const result=evidence(envelope,c.types,c.activities,now,c.eventType);return intends?result.pending:result.completed;}))return sentence;
    return intends?'这个动作还没有安排，先等等。':'这个动作的执行结果还没有确认。';
  }).join('');
}
