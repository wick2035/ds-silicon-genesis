// Only real, already-dispatched attempts enter this transient model history.
// The original user request stays before these assistant/tool pairs.
export function serviceTraceMessages(trace, selection, {createAssistantMessage, createToolResultMessage}) {
  return (trace || []).flatMap(attempt => [
    createAssistantMessage({source:selection,content:[
      {type:'text',text:'【刚才尚未说出口的意图，不是完成事实】'+attempt.intention+
        (attempt.feeling?'\n【当时心绪，仅主观感受】'+JSON.stringify(attempt.feeling):'')},
      {type:'tool-call',id:attempt.id,name:'pet_life_service',arguments:JSON.stringify({command:attempt.command})},
    ]}),
    createToolResultMessage({callId:attempt.id,isError:attempt.receipt.ok===false,content:[
      {type:'text',text:JSON.stringify({receipt:attempt.receipt,current:attempt.snapshot})},
    ]}),
  ]);
}
