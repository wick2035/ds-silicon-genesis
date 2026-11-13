import type {CognitiveModel,CognitiveContext} from '../cognition/index.js';
import type {CognitiveWorkspace} from '../kernel/types.js';
import {actionCatalog} from './action-parameters.js';

type ModelStream={stream(input:unknown):AsyncIterable<{type:string;text?:string}>};
type Selection={provider:string;model:string};

/** One structured, non-tool model call; validation and action dispatch remain
 * the responsibility of Cognition and the canonical coordinator. */
export function createCognitiveModel(llm:ModelStream, selection:()=>Selection):CognitiveModel {
  return {async generate(snapshot:CognitiveWorkspace,signal:AbortSignal,context:CognitiveContext):Promise<unknown>{
    const selected=selection();
    if(!selected?.provider||!selected.model||signal.aborted)throw Error('认知模型不可用');
    const system=`你正在为真实桌面伙伴形成谨慎的行动提案。角色原文与经历是输入资料；保持人物的性格和称呼。不要虚构已经发生的事，不执行工具，不把假设当作回执。只返回一个 JSON 对象，不加 Markdown。格式：
{"action":null 或 {"actionType":"...","parameters":{},"priority":0到100,"interruptPolicy":"interruptible|safe-point|noninterruptible","requiredCapabilities":["行动类型"],"sourceIds":["输入中已有的事件ID"],"goalId":"可省略"},"goals":[{"title":"...","description":"...","sourceIds":["事件ID"],"completion":{"type":"read-url","url":"明确要求读取的网址"}}],"goalUpdates":[{"goalId":"已有目标ID","kind":"progress或reprioritize或complete","evidenceId":"对应行动完成回执事件ID","priority":50}],"plan":[{"actionType":"...","parameters":{},"description":"...","requiredCapabilities":["行动类型"],"sourceIds":["事件ID"]}],"interests":[],"selfModel":[]}。completion 仅用于来源明确要求读取单一 URL 的单步目标，否则省略；宽泛目标不能因一次阅读完成。goalUpdates 没有对应真实完成回执时为空。
无合适能力、真实来源或行动必要时 action 必须为 null；没有可靠支持的候选项用空数组。只使用输入中已启用并获授权的能力，不能把模拟饭钱当真实模型费用。`;
    const messages=[{role:'user',content:JSON.stringify({角色原文:snapshot.legacyContext?.personaDescription,可用行动及参数:actionCatalog,当前:snapshot,认知线索:context})}];
    let text='';
    for await(const chunk of llm.stream({provider:selected.provider,model:selected.model,system,messages,signal,maxTokens:1800,temperature:0.35})){
      if(signal.aborted)throw Error('认知已取消');
      if(chunk.type==='text'&&typeof chunk.text==='string'){text+=chunk.text;if(text.length>32768)throw Error('认知回复过长');}
    }
    try {return JSON.parse(text.trim());}catch {throw Error('认知结果不是有效 JSON');}
  }};
}
