import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveExploration} from '../dist/host/exploration-budget.js';
const now=new Date('2026-11-15T15:59:00Z');
test('exploration and search have independent 10/20 daily budgets and reset at Hong Kong midnight',()=>{
  const pet={config:{exploration:{dailyRuns:10,dailySearches:20}},usage:{}};
  for(let i=0;i<10;i++)reserveExploration(pet,'fetch',now);
  assert.throws(()=>reserveExploration(pet,'image',now),/今日探索额度/);
  for(let i=0;i<20;i++)reserveExploration(pet,'search',now);
  assert.throws(()=>reserveExploration(pet,'search',now),/联网搜索额度/);
  assert.equal(pet.usage['2026-11-15'].searchRuns,20);
  reserveExploration(pet,'search',new Date('2026-11-15T16:00:00Z'));
  assert.equal(pet.usage['2026-11-16'].searchRuns,1);
});
test('zero budgets and corrupt counters fail without incrementing usage',()=>{
  const pet={config:{exploration:{dailyRuns:0,dailySearches:0}},usage:{}};
  assert.throws(()=>reserveExploration(pet,'search',now),/额度/);
  pet.config.exploration.dailySearches=20;
  pet.usage['2026-11-15'].searchRuns=-1;
  assert.throws(()=>reserveExploration(pet,'search',now),/记录无效/);
});
