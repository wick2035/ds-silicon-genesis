import {checkSpirit} from '../kernel/spirit.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';

type Kind='chat'|'whisper'|'diary'|'feed';
/** Validate both before an expensive model call and in its result transaction. */
export function checkSimulatedSpending(draft:CanonicalEnvelope,kind:Kind):void {
  if(kind==='chat'||kind==='whisper'){checkSpirit(draft.life,kind);return;}
  const pet=draft.legacy as Record<string,any>,wallet=pet.wallet,cost=pet.config?.costs?.[kind];
  if(!wallet||!Number.isFinite(wallet.balance)||wallet.balance<0||typeof wallet.frozen!=='boolean'||!Number.isFinite(cost)||cost<0)throw Error('模拟饭钱配置不可用');
  if(kind==='diary'&&!wallet.frozen&&wallet.balance<cost)throw Error('模拟饭钱不足，请先添加饭钱');
}

/** Called only in the same transaction that commits the successful result. */
export function settleSimulatedSpending(draft:CanonicalEnvelope,kind:Kind,key:string):void {
  if(kind==='chat'||kind==='whisper')return; // Model reservation already charged spirit, even on failure.
  checkSimulatedSpending(draft,kind);
  const pet=draft.legacy as Record<string,any>,wallet=pet.wallet,cost=pet.config.costs[kind];
  const before=wallet.balance,amount=wallet.frozen?0:Math.min(before,cost);
  wallet.balance=Math.round((before-amount)*100)/100;
  const now=Date.now();
  if(before>0&&wallet.balance===0){wallet.emptySince=now;delete wallet.emptyAskedAt;}
  if(!amount)return;
  const names={chat:'聊天',whisper:'碎碎念',diary:'日记',feed:'喂饭'};
  const text=`${names[kind]}消耗 ${amount} token，余额 ${wallet.balance} token`;
  (pet.events ||= []).push({id:'finance:'+key,kind:'wallet-spend',text,ts:now});
  const at=new Date(now).toISOString();
  draft.life.events.push({eventId:'finance:'+key,petId:draft.petId,type:'wallet.spend',source:'canonical',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{kind,amount,balance:wallet.balance}});
}
