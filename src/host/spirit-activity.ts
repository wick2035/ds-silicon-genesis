import {advanceSpirit} from '../kernel/spirit.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
/** Preflight and receipt settlement share the same sweet limits. */
export function sweetPrice(draft:CanonicalEnvelope,now=Date.now()):number {
  const s=advanceSpirit(draft.life,now),pet=draft.legacy as Record<string,any>;
  if(s.mode!=='awake'||s.lastSweetAt!==undefined&&now-s.lastSweetAt<s.config.sweetCooldownHours*3600000)throw Error('暂时不能再吃甜食');
  const price=Math.round(pet.config?.costs?.feed*25)/100;
  const amount=pet.wallet?.frozen===true?0:price;
  if(!Number.isFinite(price)||price<0||!Number.isFinite(pet.wallet?.balance)||pet.wallet.balance<amount)throw Error('甜食饭钱不足');
  return amount;
}
