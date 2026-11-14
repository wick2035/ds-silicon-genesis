import test from 'node:test';
import assert from 'node:assert/strict';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {createLegacyServiceActions} from '../dist/host/legacy-service-actions.js';

test('零饱腹时休息或冷却会在投喂动作前明确提示', async () => {
  const now=Date.now(), human=createHumanity(now);
  human.stats.satiety=0;
  human.sleeping=true;
  const state={humanity:human,legacy:{},life:{actions:[]}};
  let writes=0;
  const service=createLegacyServiceActions(
    {loadEnvelope:async()=>structuredClone(state)},
    {signal:new AbortController().signal,run:async(_id,fn)=>fn()},
    {apply:async()=>{writes++;}},
    {queue:async()=>{throw Error('不能排队');}},
    {dispatch:async()=>{throw Error('不能播放');}},
  );
  const request={key:'feed-test-123',command:'/喂'};
  await assert.rejects(service('main',request),/正在休息，请先叫醒/);
  human.sleeping=false;
  human.awakeUntil=now+60000;
  human.cooldowns.feed=now+60000;
  await assert.rejects(service('main',request),/刚投喂过/);
  assert.equal(writes,0);
});
