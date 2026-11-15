import type {CanonicalEnvelope} from '../storage/postgres.js';

export function groupChatBlocked(draft:Readonly<CanonicalEnvelope>):boolean {
  return (draft.legacy as Record<string,any>).config?.qqGroupBlocked===true;
}

export function groupMessageAllowed(draft:CanonicalEnvelope,occurredAt:string):boolean {
  if(groupChatBlocked(draft))return false;
  for(let i=draft.life.events.length-1;i>=0;i--){const event=draft.life.events[i];
    if(event.type==='management.group-chat')return Date.parse(occurredAt)>=Date.parse(event.occurredAt);
  }
  return true;
}

/** A ban also retires earlier reply anchors; restoring access cannot replay
 * messages that were waiting before the ban. Private QQ is independent. */
export function assertGroupReplyAllowed(draft:CanonicalEnvelope,sourceId:string):void {
  if(groupChatBlocked(draft))throw Error('爸爸已禁止群聊');
  let banned=-1;
  for(let i=draft.life.events.length-1;i>=0;i--)if(draft.life.events[i].type==='management.group-chat'&&(draft.life.events[i].payload as any)?.blocked===true){banned=i;break;}
  if(banned>=0 && draft.life.events.findIndex(e=>e.eventId===sourceId)<=banned)throw Error('群聊回复已过期');
}
