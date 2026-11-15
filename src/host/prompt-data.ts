/** Bounded JSON for optional historical context; never cut serialized JSON. */
export function promptData(value:unknown,limit:number):string {
  let stringLimit=600,arrayLimit=8;
  const project=(v:any,key=''):any=>typeof v==='string'?(/(?:^id$|Id$|Ids$)/u.test(key)?v:v.length>stringLimit?v.slice(0,stringLimit)+'…[节选]':v):
    Array.isArray(v)?v.slice(-arrayLimit).map(item=>project(item,key)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,item])=>[k,project(item,k)])):v;
  for(let attempt=0;attempt<12;attempt++){
    const text=JSON.stringify(project(value))??'null';
    if(text.length<=limit)return text;
    stringLimit=Math.max(40,Math.floor(stringLimit/2));arrayLimit=Math.max(1,Math.floor(arrayLimit/2));
  }
  return JSON.stringify({omitted:true,reason:'历史资料超出本轮预算，请按话题检索'});
}
