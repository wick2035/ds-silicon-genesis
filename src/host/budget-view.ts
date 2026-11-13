export function budgetView(pet:Record<string,any>,now:Date) {
  if(!(now instanceof Date) || !Number.isFinite(now.valueOf()))throw Error('预算日期无效');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const limit=pet.config?.learning?.dailyModelCalls, cap=pet.config?.modelBudget?.interactiveDailyCalls, usage=pet.usage?.[day];
  const total=usage?.totalCalls??0, interactive=usage?.interactiveCalls??0;
  if((limit!==undefined && (!Number.isSafeInteger(limit)||limit<0)) || (cap!==undefined && (!Number.isSafeInteger(cap)||cap<0)) || !Number.isSafeInteger(total)||total<0 || !Number.isSafeInteger(interactive)||interactive<0)throw Error('模型预算记录损坏');
  return {budgetDay:day,remainingBudget:Math.max(0,Math.max(0,(limit??0)-2)-total),interactiveRemaining:cap===undefined?null:Math.max(0,cap-interactive)};
}
