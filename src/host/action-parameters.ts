export const actionCatalog = {'self.express':'{text:string}','service.sweet':'{}','care.water':'{}','service.buy-rice':'{}','service.eat-rice':'{itemId:string}','labor.step':'{contractId:string,commandId:string}','token.pickup':'{coinId:string}','body.activity':'{activity:"walk"|"run"|"play"|"cube"|"juggle"|"dance"|"hum"|"stretch"|"bubble"|"look",target?:"left"|"right"|"center"}','body.sleep':'{mode?:"nap"}','body.wake':'{}','image.observe':'{query:string,attachmentId:string,attachmentSourceId:string}','learning.observe':'{kind:"search"|"fetch"|"bili",query:string,url?:string,followUpQuestion?:string}'} as const;
export function validateActionParameters(type:string,p:Record<string,unknown>):void {
  const str=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
  if(!p||typeof p!=='object'||Array.isArray(p))throw Error('行动参数无效');
  const fields:Record<string,string[]>={'self.express':['text'],'service.sweet':['legacyCommand'],
    'service.buy-rice':['legacyCommand'],'care.feed':['legacyCommand'],'care.water':['legacyCommand'],'care.pet':['legacyCommand'],'care.play':['legacyCommand'],'care.soothe':['legacyCommand'],'care.accompany':['legacyCommand'],'body.sleep':['legacyCommand','mode'],'body.wake':['legacyCommand'],
    'body.activity':['activity','target'],
    'service.eat-rice':['itemId','legacyCommand'],'token.pickup':['coinId'],'labor.step':['contractId','commandId'],
    'image.observe':['query','attachmentId','attachmentSourceId','legacyCommand','kind','wishId'],
    'learning.observe':['kind','query','url','followUpQuestion','legacyCommand','wishId','careAction']};
  if(!fields[type] || Object.keys(p).some(key=>!fields[type].includes(key)))throw Error('行动包含未知参数');
  for(const key of ['legacyCommand','wishId','careAction'])if(p[key]!==undefined&&!str(p[key],300))throw Error('行动参数无效');
  if(type==='self.express' && str(p.text,200))return;
  if(type==='service.sweet')return;
  if(type==='body.sleep' && p.mode!==undefined && p.mode!=='nap')throw Error('睡眠模式无效');
  if(['service.buy-rice','care.feed','care.water','care.pet','care.play','care.soothe','care.accompany','body.sleep','body.wake'].includes(type))return;
  if(type==='body.activity' && ['walk','run','play','cube','juggle','dance','hum','stretch','bubble','look'].includes(String(p.activity)) && (['walk','run'].includes(String(p.activity)) ? ['left','right','center'].includes(String(p.target)) : p.target===undefined))return;
  if(type==='image.observe'&&str(p.query,300)&&typeof p.attachmentId==='string'&&/^image:[a-f0-9]{64}$/.test(p.attachmentId)&&str(p.attachmentSourceId,200))return;
  if(type==='service.eat-rice'&&str(p.itemId,200))return;
  if(type==='token.pickup'&&str(p.coinId,200))return;
  if(type==='labor.step'&&str(p.contractId,200)&&str(p.commandId,200))return;
  if(type==='learning.observe'&&['search','fetch','bili'].includes(String(p.kind))&&str(p.query,300)&&(p.kind!=='fetch'||str(p.url,2048)&&/^https?:\/\//i.test(p.url as string))&&(p.followUpQuestion===undefined||str(p.followUpQuestion,200)))return;
  throw Error('行动类型或参数无效');
}
