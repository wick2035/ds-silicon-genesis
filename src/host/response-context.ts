import {CognitiveError} from '../cognition/diagnostics.js';
import {promptData} from './prompt-data.js';
import type {conversationContext} from './conversation-context.js';

/** Bound optional history before serialization; keep current actionable facts intact. */
export function responseContext(input:{task:unknown;goal?:unknown;recentConversation:unknown;materials:unknown;currentLife?:ReturnType<typeof conversationContext>;body?:unknown;emotions?:unknown;desires?:unknown;recentPhysical?:unknown}):string {
  const bounded=(value:unknown,limit:number,arrayLimit=20)=>JSON.parse(promptData(value,limit,{arrayLimit}));
  let currentLife=input.currentLife;
  if(currentLife){
    const {companion,laborHistory,operationUpdates,...live}=currentLife;
    currentLife={...live,operationUpdates:bounded(operationUpdates,2000),laborHistory:bounded(laborHistory,1200),
      companion:{...companion,
        // Provenance remains in storage. Speech needs attribution and delivery,
        // not the growing list of IDs for every merged group message.
        groupActivity:bounded(companion.groupActivity.map(({sourceIds,...item})=>item),2600),
        money:bounded(companion.money,1800),subjectiveContinuity:bounded(companion.subjectiveContinuity,800)}};
  }
  const text=JSON.stringify({...input,currentLife,task:bounded(input.task,2400),goal:bounded(input.goal,1000),
    recentConversation:bounded(input.recentConversation,6000),materials:bounded(input.materials,2400),
    ...(input.recentPhysical?{recentPhysical:bounded(input.recentPhysical,2400)}:{})});
  // Leave room for tool calls and their results within convertMessages' 32K cap.
  if(text.length>24000)throw new CognitiveError('context_overflow','回应上下文超过限制');
  return text;
}
