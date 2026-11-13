export type ImageResolver = (attachment: unknown, signal: AbortSignal) => Promise<{mediaType:string; data:Uint8Array}>;
const media = new Set(['image/png','image/jpeg','image/webp','image/gif']);
/** Resolve only through the host's authenticated attachment service. */
export async function convertMessages(input: unknown[], provider: 'openai-completions'|'anthropic-messages', signal: AbortSignal, resolveImage?: ImageResolver): Promise<any[]> {
  if (!Array.isArray(input) || !input.length || input.length > 64) throw new Error('模型输入无效');
  const result:any[]=[]; let total=0;
  for (const raw of input) {
    if (!raw || typeof raw!=='object') throw new Error('模型输入无效');
    const m=raw as any, blocks=typeof m.content==='string'?[{type:'text',text:m.content}]:m.content;
    if (!Array.isArray(blocks) || blocks.length>128 || !['user','assistant','tool'].includes(m.role)) throw new Error('模型输入无效');
    const content:any[]=[], calls:any[]=[];
    for (const b of blocks) {
      if (b?.type==='text' && typeof b.text==='string') {total+=b.text.length;content.push(provider==='openai-completions'?{type:'text',text:b.text}:{type:'text',text:b.text});}
      else if (b?.type==='image' && m.role==='user') {
        if (!resolveImage) throw new Error('图片附件服务不可用');
        const image=await resolveImage(b.attachment,signal);
        if(signal.aborted || !media.has(image.mediaType) || !(image.data instanceof Uint8Array) || !image.data.length || image.data.length>5_000_000) throw new Error('图片附件无效');
        const data=Buffer.from(image.data).toString('base64');
        content.push(provider==='openai-completions'?{type:'image_url',image_url:{url:`data:${image.mediaType};base64,${data}`}}:{type:'image',source:{type:'base64',media_type:image.mediaType,data}});
      } else if (b?.type==='tool-call' && m.role==='assistant' && typeof b.id==='string' && typeof b.name==='string' && typeof b.arguments==='string') {
        total+=b.arguments.length;
        if(provider==='openai-completions')calls.push({id:b.id,type:'function',function:{name:b.name,arguments:b.arguments}});
        else {let parsed:unknown;try{parsed=JSON.parse(b.arguments);}catch{throw new Error('工具参数无效');}content.push({type:'tool_use',id:b.id,name:b.name,input:parsed});}
      } else throw new Error('不支持的消息内容');
    }
    if(total>32768)throw new Error('模型输入超过限制');
    if(m.role==='tool') {
      const id=m.toolCallId ?? m.source?.callId;
      if(typeof id!=='string'||!id || content.some(x=>x.type!=='text'))throw new Error('工具结果无效');
      if(provider==='openai-completions')result.push({role:'tool',tool_call_id:id,content:content.map(x=>x.text).join('')});
      else result.push({role:'user',content:[{type:'tool_result',tool_use_id:id,content:content.map(x=>x.text).join(''),is_error:!!m.isError}]});
    } else if(provider==='openai-completions') result.push({role:m.role,content:content.length?content:null,...(calls.length?{tool_calls:calls}:{})});
    else result.push({role:m.role,content});
  }
  return result;
}
