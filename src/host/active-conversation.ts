import type {CanonicalEnvelope} from '../storage/postgres.js';
/** All channels pause new work steps while a live chat is being answered. */
export function hasRunningChat(state:CanonicalEnvelope,now=Date.now()):boolean {
  return Object.values((state.legacy as any).chatTurns??{}).some((turn:any)=>turn.status==='running'&&Number.isFinite(turn.at)&&now-turn.at<120000);
}
/** Running turns protect their tool continuations from automatic sleep/meal races. */
export function hasActiveConversation(state:CanonicalEnvelope,now=Date.now()):boolean {
  const pet=state.legacy as any,needs=pet.autonomousNeeds;
  return needs?.status==='running'&&Number.isFinite(needs.at)&&now-needs.at<120000 || Object.values(pet.chatTurns??{}).some((turn:any)=>turn.status==='running'&&turn.wakeRequested===true&&Number.isFinite(turn.at)&&now-turn.at<120000);
}
