export const actionCatalog = {'service.buy-rice':'{}','service.eat-rice':'{itemId:string}','labor.step':'{contractId:string,commandId:string}','token.pickup':'{coinId:string}','body.sleep':'{}','body.wake':'{}','image.observe':'{query:string,attachmentId:string,attachmentSourceId:string}','learning.observe':'{kind:"search"|"fetch"|"bili",query:string,url?:string,followUpQuestion?:string}'} as const;
export function validateActionParameters(type:string,p:Record<string,unknown>):void {
  const str=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
  if(!p||typeof p!=='object'||Array.isArray(p))throw Error('行动参数无效');
  const fields:Record<string,string[]>={
    'service.buy-rice':['legacyCommand'],'care.feed':['legacyCommand'],'body.sleep':['legacyCommand'],'body.wake':['legacyCommand'],
    'service.eat-rice':['itemId','legacyCommand'],'token.pickup':['coinId'],'labor.step':['contractId','commandId'],
    'image.observe':['query','attachmentId','attachmentSourceId','legacyCommand','kind','wishId'],
    'learning.observe':['kind','query','url','followUpQuestion','legacyCommand','wishId','careAction']};
  if(!fields[type] || Object.keys(p).some(key=>!fields[type].includes(key)))throw Error('行动包含未知参数');
  for(const key of ['legacyCommand','wishId','careAction'])if(p[key]!==undefined&&!str(p[key],300))throw Error('行动参数无效');
  if(['service.buy-rice','care.feed','body.sleep','body.wake'].includes(type))return;
  if(type==='image.observe'&&str(p.query,300)&&typeof p.attachmentId==='string'&&/^image:[a-f0-9]{64}$/.test(p.attachmentId)&&str(p.attachmentSourceId,200))return;
  if(type==='service.eat-rice'&&str(p.itemId,200))return;
  if(type==='token.pickup'&&str(p.coinId,200))return;
  if(type==='labor.step'&&str(p.contractId,200)&&str(p.commandId,200))return;
  if(type==='learning.observe'&&['search','fetch','bili'].includes(String(p.kind))&&str(p.query,300)&&(p.kind!=='fetch'||str(p.url,2048)&&/^https?:\/\//i.test(p.url as string))&&(p.followUpQuestion===undefined||str(p.followUpQuestion,200)))return;
  throw Error('行动类型或参数无效');
}
