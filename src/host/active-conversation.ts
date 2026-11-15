import type {CanonicalEnvelope} from '../storage/postgres.js';
/** Running turns protect their tool continuations from automatic sleep/meal races. */
export function hasActiveConversation(state:CanonicalEnvelope,now=Date.now()):boolean {
  return Object.values((state.legacy as any).chatTurns??{}).some((turn:any)=>turn.status==='running'&&turn.wakeRequested===true&&Number.isFinite(turn.at)&&now-turn.at<120000);
}
