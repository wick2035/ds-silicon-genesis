import {createHash} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import {groupPeople} from './group-people.js';

type Identity={appId:string;groupOpenid?:string;groupOwnerOpenid?:string};
type MemberRoute={memberOpenid:string;sourceEventId:string};
export type GroupMention={actorId:string;sourceEventId:string};
export type MentionCandidate={actorId:string;name:string;aliases:string[];available:boolean;sourceIds:string[]};
export const MENTION_INTERVAL=10*60*1000;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const groupActorId=(identity:Identity,openid:string)=>openid===identity.groupOwnerOpenid?'dad':'qq-member:'+hash(identity.appId+':'+openid).slice(0,24);
export const mentionGroupId=(identity:Identity)=>identity.groupOpenid?hash(identity.appId+':'+identity.groupOpenid):undefined;
const openid=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\s<>\x00-\x1f]/u.test(value);
export const rawMentionMarkup=(text:string)=>/<\s*(?:qqbot-|@)|@everyone|\[qq-at\b/iu.test(text);

/** Only called from authenticated, accepted group ingress. Raw routing stays
 * private; public events and model context contain the stable actor ID only. */
export function rememberGroupMember(draft:CanonicalEnvelope,memberOpenid:string,sourceEventId:string):void {
  const qq=(draft.legacy as any).qq,groupId=mentionGroupId(qq.identity);
  if(!groupId||!openid(memberOpenid))return;
  qq.memberRoutes??={};const routes=qq.memberRoutes[groupId]??={};
  routes[groupActorId(qq.identity,memberOpenid)]={memberOpenid,sourceEventId};
}

export function resolveGroupMember(draft:CanonicalEnvelope,actorId:string,sourceEventId?:string):MemberRoute|undefined {
  const qq=(draft.legacy as any).qq,identity=qq?.identity as Identity|undefined;
  if(!identity||!actorId||actorId!=='dad'&&!/^qq-member:[a-f0-9]{24}$/u.test(actorId))return;
  const groupId=mentionGroupId(identity),route=groupId?qq.memberRoutes?.[groupId]?.[actorId] as MemberRoute|undefined:undefined;
  if(!route||!openid(route.memberOpenid)||groupActorId(identity,route.memberOpenid)!==actorId)return;
  // Validate both the latest observation and the observation selected when the
  // intent was committed; deleting either must not revive a queued mention.
  for(const id of new Set([route.sourceEventId,sourceEventId??route.sourceEventId])){
    const event=draft.life.events.find(e=>e.eventId===id),p=event?.payload as any;
    if(!event||event.type!=='social.message'||event.source!=='qq'||event.evidenceLevel!=='observed'||event.actorId!==actorId||p?.scene!=='group'||p.groupId!==groupId||Object.hasOwn(draft.life.invalidSources,id))return;
  }
  return route;
}

export function mentionAvailable(draft:CanonicalEnvelope,actorId:string,now=Date.now(),excludeActionId?:string):boolean {
  const route=resolveGroupMember(draft,actorId);if(!route)return false;
  const destination=(draft.legacy as any).qq.identity.groupOpenid;
  const latestSpeech=draft.life.events.find(e=>e.eventId===route.sourceEventId);
  // A delayed packet from before the mention is not a new answer. Neither a
  // future platform timestamp nor receipt time alone can reset the cooldown.
  const spokeAt=Math.min(Date.parse(latestSpeech?.receivedAt??''),Date.parse(latestSpeech?.occurredAt??''));
  return !draft.life.actions.some(a=>{
    if(a.id===excludeActionId||a.actionType!=='qq.send'||a.parameters.scene!=='group'||a.parameters.destination!==destination||a.parameters.mentionActorId!==actorId||a.status==='CANCELLED')return false;
    const dispatchIndex=draft.life.events.findIndex(e=>e.eventId==='action-dispatched:'+a.id);
    const at=Date.parse(dispatchIndex>=0?draft.life.events[dispatchIndex].occurredAt:a.createdAt);
    const replied=spokeAt>at||spokeAt===at&&dispatchIndex>=0&&draft.life.events.indexOf(latestSpeech!)>dispatchIndex;
    return a.status==='PENDING'||now-at<MENTION_INTERVAL&&!replied;
  });
}

export function groupMentionCandidates(draft:CanonicalEnvelope,groupId:unknown,actors:string[],query:string):MentionCandidate[] {
  const identity=(draft.legacy as any).qq?.identity;
  if(!identity||groupId!==mentionGroupId(identity))return [];
  const people=groupPeople(draft.life,groupId as string);
  const candidates=people.map(p=>{
    const distinct=[...new Map(p.names.map(n=>[n.name,n])).values()],names=distinct.map(n=>n.name),latest=p.remark??p.names.at(-1);
    const relevant=distinct.filter(n=>query.includes(n.name));
    return {actorId:p.actorId,name:latest?.name??'群友-'+p.actorId.slice(-12),aliases:[...new Set([...names.slice(-4),...relevant.map(n=>n.name)])],
      available:false,sourceIds:[...new Set([...(latest?[latest.sourceId]:[]),...relevant.map(n=>n.sourceId)])]};
  });
  const owner=resolveGroupMember(draft,'dad');
  if(owner)candidates.push({actorId:'dad',name:'爸爸',aliases:['爸爸'],available:false,sourceIds:[owner.sourceEventId]});
  // Query matches are selected together: a duplicate nickname must never turn
  // into a single plausible target merely because the list was truncated.
  const matches=candidates.filter(p=>query.includes(p.actorId)||query.includes(p.name)||p.aliases.some(n=>query.includes(n)));
  const current=candidates.filter(p=>actors.includes(p.actorId));
  return [...new Set([...matches,...current,...candidates.slice(-8)])].slice(0,32).map(p=>{
    const ambiguous=matches.some(other=>other.actorId!==p.actorId&&[p.name,...p.aliases].some(n=>query.includes(n)&&[other.name,...other.aliases].includes(n)));
    const route=resolveGroupMember(draft,p.actorId);
    return {...p,available:!(ambiguous&&!query.includes(p.actorId))&&mentionAvailable(draft,p.actorId),sourceIds:[...new Set([...p.sourceIds,...(route?[route.sourceEventId]:[])])]};
  });
}

export const GROUP_MENTION_RULE=`【单人点名】只有明确叫人、需要本人回答或重要追问才 @；普通接话不用。每句最多点名一位候选中的人物，available 为 false 时不能点名。同一人未再次发言前，10分钟内不重复提醒。称呼同名且目标不明确时先问清楚，不猜身份。“叫醒”只表示发出一次提醒，不能声称对方已经醒来、看到或答应；不用连续催促，不点名全体。候选的 name 优先使用备注，aliases 是历史称呼。若决定点名，在正文末尾追加且仅追加一次 [qq-at:人物编号]；不点名就只输出正文。正文最多15字素，控制标记不计入；不输出任何原始QQ标签、@everyone或原始账号，也不要用普通“@昵称”冒充通知。点名时直接向该人说话，不向别人宣称“已经提醒成功”。无法点名时用普通称呼回答或说明暂时无法点名。`;

export function parseGroupMention(text:string):{text:string;mentionActorId?:string;invalid?:boolean} {
  const match=/\s*\[qq-at:(dad|qq-member:[a-f0-9]{24})\]\s*$/u.exec(text);
  const body=(match?text.slice(0,match.index):text).trim();
  if(rawMentionMarkup(body)||/^[@＠]/u.test(body)||(!match&&rawMentionMarkup(text)))return {text:'',invalid:true};
  return {text:body,...(match?{mentionActorId:match[1]}:{})};
}

export function qqMentionContent(text:string,memberOpenid?:string):string {
  if(rawMentionMarkup(text))throw Error('QQ 正文包含未授权点名标记');
  if(memberOpenid===undefined)return text;
  if(!openid(memberOpenid))throw Error('QQ 点名账号无效');
  const escaped=memberOpenid.replace(/[&"']/gu,c=>({'&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
  return `<qqbot-at-user id="${escaped}" /> ${text}`;
}
