import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLegacySnapshot} from '../dist/host/legacy-snapshot.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

test('旧搬砖念头不会在痛苦恢复后被当作当前气泡重播', () => {
  const now=Date.now(), humanity=createHumanity(now);
  humanity.stats.pain=0;
  const contract={id:'old-job',status:'paused',thought:'痛得动不了，先趴会儿'};
  const envelope={petId:'main',version:0,humanity,legacy:{labor:{contracts:[contract]}},life:{constraints:{paused:false}}};
  const projected=projectLegacySnapshot(envelope,{},now);
  assert.equal(projected.world.affect.pain,0);
  assert.equal(projected.world.labor.current.thought,'');
  assert.equal(projected.labor.current.thought,'');
  assert.equal(contract.thought,'痛得动不了，先趴会儿');
  assert.equal(projected.world.labor.current.id,'old-job');
});
