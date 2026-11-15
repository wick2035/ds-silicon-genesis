/** Reserve separate daily budgets inside the action's atomic transaction. */
export function reserveExploration(pet:Record<string,any>,ability:string,now:Date):void {
  const search=ability==='search';
  const daily=search?(pet.config?.exploration?.dailySearches??20):pet.config?.exploration?.dailyRuns;
  if(!Number.isSafeInteger(daily)||daily<0||daily>(search?20:10)||!pet.usage||typeof pet.usage!=='object')throw Error('探索额度配置无效');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const usage=pet.usage[day] ||= {exploreRuns:0,modelCalls:0,diaryAttempts:0,diarySuccess:0,totalCalls:0,newStrategies:0,reflectionAttempts:0};
  const key=search?'searchRuns':'exploreRuns';
  const used=usage[key]??0;
  if(!Number.isSafeInteger(used)||used<0)throw Error('探索次数记录无效');
  if(used>=daily)throw Error(search?'今日联网搜索额度已用完':'今日探索额度已用完');
  usage[key]=used+1;
}
