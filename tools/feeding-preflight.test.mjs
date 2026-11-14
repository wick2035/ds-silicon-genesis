import test from 'node:test';
import assert from 'node:assert/strict';
import {createHumanity,actHumanity,describeHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {createLegacyServiceActions} from '../dist/host/legacy-service-actions.js';
import {projectBody,projectActionBody} from '../dist/host/body-projection.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';

test('午休时段不会自动进入休息，吃喝与冷却按实际身体状态判断', () => {
  const now=Date.parse('2026-11-14T05:00:00Z'),human=createHumanity(now);
  human.stats.satiety=0;
  assert.equal(describeHumanity(human,now).resting,false);
  const fed=actHumanity(human,'feed',now);
  assert.equal(fed.ok,true);
  assert.ok(describeHumanity(fed.state,now+25000).stats.satiety>0);
  assert.equal(actHumanity(fed.state,'feed',now+1000).reason,'cooldown');
  human.stats.satiety=30;
  assert.equal(actHumanity(human,'feed',now).ok,true);
  human.stats.satiety=31;
  assert.equal(actHumanity(human,'feed',now).ok,true);
  human.stats.satiety=0;
  human.sleeping=true;
  assert.equal(actHumanity(human,'feed',now).reason,'resting');
  human.sleeping=false;
  assert.equal(actHumanity(human,'water',now).ok,true);
  human.restingUntil=now+60000;
  assert.equal(actHumanity(human,'water',now).reason,'resting');
});

test('休息中的饥饿投喂能通过动作校验并凭回执增加饱腹', () => {
  const now=Date.now(),human=createHumanity(now);
  human.stats.satiety=0;human.restingUntil=now+60000;
  human.helperReady=true;human.restrained=false;
  const draft={petId:'main',humanity:human,legacy:{wallet:{balance:100,frozen:false},config:{costs:{feed:0}}},life:{events:[],relationships:[],invalidSources:{}}};
  const projected=projectBody(draft);
  assert.equal(projected.body.sleeping,true);
  assert.equal(projectActionBody(draft,projected,'care.feed').body.sleeping,false);
  assert.equal(projectActionBody(draft,projected,'service.eat-rice').body.sleeping,false);
  assert.equal(projectActionBody(draft,projected,'labor.step').body.sleeping,true);
  const intent={id:'feed-test',type:'care.feed',payload:{parameters:{}}};
  const receipt={status:'completed',evidence:{confirmed:true,actionId:intent.id,kind:intent.type,played:true,itemId:'parent'}};
  projectOutcome(draft,intent,receipt,new Date(now).toISOString(),'receipt');
  assert.ok(describeHumanity(draft.humanity,now+25000).stats.satiety>0);
});

test('睡眠或冷却会在投喂动作前明确提示', async () => {
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
  await assert.rejects(service('main',request),/正在睡觉，请先叫醒/);
  human.sleeping=false;
  human.awakeUntil=now+60000;
  human.cooldowns.feed=now+60000;
  await assert.rejects(service('main',request),/刚照料过/);
  assert.equal(writes,0);
});
