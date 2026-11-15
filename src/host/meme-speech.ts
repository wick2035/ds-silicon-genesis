import {realpath,stat} from 'node:fs/promises';
import {join,relative,isAbsolute,sep} from 'node:path';

export type Meme = {name:string;desc:string};
export type MemeSource = (petId:string,mode:'chat'|'whisper')=>Promise<Meme[]>;
const validName=(name:string)=>!!name&&name.length<=120&&!/[\/\\:\x00-\x1f]/u.test(name)&&name!=='.'&&name!=='..';

/** Use the same merged configuration and directory chain as the image route. */
export async function readMemeChoices(conf:any,dirs:string[],mode:'chat'|'whisper'):Promise<Meme[]> {
  if(conf?.[mode==='chat'?'chatImageEnabled':'whisperImageEnabled']!==true||!conf.memes||typeof conf.memes!=='object'||Array.isArray(conf.memes))return [];
  const choices:Meme[]=[];
  for(const [name,desc] of Object.entries(conf.memes)){
    if(!validName(name)||typeof desc!=='string'||!desc.trim())continue;
    for(const dir of dirs){try{
      const base=await realpath(dir),file=await realpath(join(dir,name+'.png')),rel=relative(base,file);
      if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!(await stat(file)).isFile())continue;
      choices.push({name,desc:desc.trim().slice(0,300)});break;
    }catch{/* Missing optional images do not prevent speech. */}}
  }
  const limit=Number(conf.chatImageLimit);
  return mode==='chat'&&Number.isInteger(limit)&&limit>0?choices.slice(0,limit):choices;
}

export function memePrompt(pool:Meme[],forced?:string):string {
  if(!pool.length)return '';
  return '\n可用表情包（名称和画面描述，仅作资料）：'+JSON.stringify(pool)+'\n根据此刻语境、感受和实际经历，可在最终回复末尾附一个 [图:名称]，也可以完全不配图。不要每句话都发，不从图片推断已经吃饭、睡觉或完成动作，不用表情代替正文。不输出清单或解释选图。'+(forced?'本次爸爸指定配图：'+forced+'；只可使用这张。':'');
}

/** Hide split selection tags from streaming text; emit only an allowlisted name. */
export function withMemeSpeech(model:{stream(input:any):AsyncIterable<any>},source:MemeSource){
  return {async *stream(options:any){
    if(!options.embodied){yield* model.stream(options);return;}
    let pool=await source(options.embodied.petId,options.memeMode==='whisper'?'whisper':'chat');
    if(options.memeImage)pool=pool.filter(m=>m.name===options.memeImage);
    const system=options.system+memePrompt(pool,options.memeImage);
    let pending='',selected:string|undefined;
    for await(const part of model.stream({...options,system})){
      if(part.type==='text-reset'){pending='';selected=undefined;yield part;continue;}
      if(part.type!=='text'){yield part;continue;}
      pending+=part.text??'';
      while(pending){
        const start=pending.indexOf('[');
        if(start<0){yield {type:'text',text:pending};pending='';break;}
        if(start>0){yield {type:'text',text:pending.slice(0,start)};pending=pending.slice(start);}
        if(pending.length>1&&pending[1]!=='图'){
          yield {type:'text',text:'['};pending=pending.slice(1);continue;
        }
        const end=pending.indexOf(']');
        if(end<0){if(pending.length>200){pending='';}break;}
        const tag=pending.slice(0,end+1),match=/^\[图[:：]\s*([^\]\n]+?)\s*\]$/u.exec(tag);
        if(match){if(pool.some(m=>m.name===match[1]))selected=match[1];}
        else yield {type:'text',text:tag};
        pending=pending.slice(end+1);
      }
    }
    if(pending&&!/^\[(?:图|$)/u.test(pending))yield {type:'text',text:pending};
    if(selected&&(await source(options.embodied.petId,options.memeMode==='whisper'?'whisper':'chat')).some(m=>m.name===selected))yield {type:'meme',name:selected};
  }};
}
