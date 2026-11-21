import type {developmentMaterial} from './development-material.js';

export const DEVELOPMENT_SOURCE_RULE='【整理来源编号】材料中每个 id（包括 speakers 中逐条发言的 id）都是本次可用的短编号。sources 只填写实际采用的完整短编号，例如 ["E1","E3"]；不要复制正文中的 sourceIds、人物编号或自行缩写编号。编号由宿主还原为真实事件，正文不写编号。';

export class DevelopmentResultError extends Error {}

/** Short references avoid asking the model to reproduce hashes. Only evidence
 * actually shown in this request can be cited, including attributed speakers. */
export function developmentSources(events:ReturnType<typeof developmentMaterial>) {
  const ids=new Set(events.flatMap(event=>[event.id,...(event.speakers??[]).map(s=>s.id)]));
  const aliases=new Map<string,string>(),originals=new Map<string,string>();
  let index=0;
  for(const id of ids){
    let alias:string;do{alias='E'+(++index);}while(ids.has(alias));
    aliases.set(id,alias);originals.set(alias,id);
  }
  return {
    events:events.map(event=>({...event,id:aliases.get(event.id)!,...(event.speakers?{speakers:event.speakers.map(s=>({...s,id:aliases.get(s.id)!}))}:{})})),
    parse(text:string):{text:string;sources:string[]} {
      let data:any;
      try{data=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
      catch{throw new DevelopmentResultError('整理内容不是有效 JSON');}
      if(!data||typeof data.text!=='string'||!data.text.trim()||data.text.length>5000)throw new DevelopmentResultError('整理正文为空或超过 5000 字符');
      if(!Array.isArray(data.sources)||!data.sources.length)throw new DevelopmentResultError('整理结果没有来源编号');
      const sources=data.sources.map((id:unknown)=>typeof id==='string'?(originals.get(id)??(ids.has(id)?id:undefined)):undefined);
      if(sources.some((id:unknown)=>!id))throw new DevelopmentResultError('整理结果含有本次材料以外的来源编号');
      return {text:data.text.trim(),sources:[...new Set<string>(sources)]};
    },
  };
}
