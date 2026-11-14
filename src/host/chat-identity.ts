import type {LifeEvent} from '../kernel/types.js';

/** The owner's two private entry points share one conversation. Group
 * conversations remain separate, including when the owner participates. */
export function isOwnerPrivateConversation(event:LifeEvent):boolean {
  return ['conversation.user','conversation.assistant'].includes(event.type) &&
    ['desktop','legacy','qq-c2c'].includes(event.source);
}

export function groupSpeaker(actorId:string|undefined):string {
  if(actorId==='dad')return '爸爸';
  return actorId?.startsWith('qq-member:') ? '群友-'+actorId.slice(-12) : '身份未确认的群友';
}
