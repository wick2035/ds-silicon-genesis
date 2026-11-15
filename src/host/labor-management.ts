type Obj=Record<string,any>;

export function laborHistory(pet:Obj) {
  return (pet.labor?.contracts||[]).slice(-12).map((c:Obj)=>({id:c.id,status:c.status,trips:c.trips,done:c.done,wage:c.wage,wageUnspecified:c.wageUnspecified===true,paid:c.paid,cancelledAt:c.cancelledAt,revisions:(c.revisions||[]).slice(-8),payments:(c.payments||[]).slice(-8)}));
}

/** Manual edits preserve observed work. No cancellation invents a wage claim. */
export function manageLabor(store:any,petId:string,input:Obj) {
  return store.update(petId,(pet:Obj)=>{
    const c=pet.labor?.contracts?.find((c:Obj)=>c.id===input.id);
    if(!c)throw Error('工作约定不存在，请刷新后重试');
    const now=store.clock();
    if(input.action==='settle-cancelled'){
      if(!['cancelled','unpaid'].includes(c.status))throw Error('这份工作尚未结束');
      const amount=input.amount;
      if(!Number.isInteger(amount)||amount<0||amount>1000000)throw Error('工钱须为 0–1000000 的整数');
      if(pet.wallet.balance+amount>1000000000)throw Error('饭钱余额达到上限');
      c.payments||=[];c.payments.push({key:input.key,amount,ts:now});c.paid+=amount;pet.wallet.balance+=amount;
      if(c.status==='unpaid'&&!c.wageUnspecified&&c.paid>=c.wage)c.status='paid';
      pet.wallet.reference=Math.max(pet.wallet.reference,pet.wallet.balance);
      store.eventIn(pet,'labor',`爸爸为已结束的工作实际支付 ${amount} token；已完成 ${c.done}/${c.trips} 趟，原约定 ${c.wage} token，累计支付 ${c.paid} token。`,null);
      return;
    }
    if(!['offered','working','paused','unpaid'].includes(c.status))throw Error('这份工作已经结束，请刷新后重试');
    const before={trips:c.trips,wage:c.wage,done:c.done,status:c.status};
    if(input.action==='adjust'){
      if(!Number.isInteger(input.trips)||input.trips<1||input.trips>50||input.trips<c.done)throw Error('趟数须为 1–50，且不能少于已完成趟数');
      if(!Number.isInteger(input.wage)||input.wage<1||input.wage>1000000)throw Error('工钱须为 1–1000000 的整数');
      c.trips=input.trips;c.wage=input.wage;c.wageUnspecified=false;c.counter=null;
      if(c.status==='offered')c.accepted=false;
      else if(c.done===c.trips)c.status='unpaid';
      else if(c.status==='unpaid')c.status='paused';
    }else if(input.action==='cancel'){
      c.status='cancelled';c.cancelledAt=now;
    }else throw Error('工作操作无效');
    c.workPermit=false;c.batchRemaining=0;c.carrying=false;c.forced=false;
    const command=pet.world?.command;
    if(command&&['labor','labor-mood'].includes(command.source)&&['queued','running'].includes(command.status)){
      command.status='interrupted';command.interruptedReason='labor-'+input.action;
    }
    pet.labor.execution=null;
    (c.revisions||=[]).push({at:now,action:input.action,before,after:{trips:c.trips,wage:c.wage,done:c.done,status:c.status}});
    const text=input.action==='cancel'
      ?`爸爸取消了工作；实际完成 ${c.done}/${c.trips} 趟，约定总工钱 ${c.wage} token，实际已付 ${c.paid} token。取消时没有约定结算金额，也没有自动付款。`
      :`爸爸调整了工作：原来 ${before.trips} 趟、${before.wage} token，现在 ${c.trips} 趟、${c.wage} token；实际已完成 ${c.done} 趟、已付 ${c.paid} token，进度保留。`;
    store.eventIn(pet,'labor',text,null);
  });
}
