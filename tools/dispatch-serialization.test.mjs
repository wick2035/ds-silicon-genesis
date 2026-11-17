import test from 'node:test';
import assert from 'node:assert/strict';
import {OutboxDispatcher} from '../dist/storage/uow.js';
import {WriterLease} from '../dist/host/writer-lease.js';

test('并发派发等待当前动作回执，并继续执行已排队的步骤',async()=>{
  const leaseClient={on(){return this},removeListener(){return this},release(){},async query(){return {rows:[{acquired:true}],rowCount:1}}};
  const gate=new WriterLease({connect:async()=>leaseClient});await gate.acquire();
  let state={petId:'main',version:0,life:{actions:[{id:'first',interruptPolicy:'safe-point'},{id:'second',interruptPolicy:'safe-point'}]}};
  const rows=new Map(['first','second'].map(id=>[id,{action_id:id,pet_id:'main',action_type:id,payload:{},state:'pending'}]));
  const pool={connect:async()=>({release(){},async query(sql,params=[]){
    if(sql.startsWith('SELECT pet_id FROM'))return {rows:[{pet_id:'main'}],rowCount:1};
    if(sql.startsWith('SELECT version::text,payload'))return {rows:[{version:String(state.version),payload:structuredClone(state)}],rowCount:1};
    if(sql.startsWith('SELECT action_id,pet_id'))return {rows:[{...rows.get(params[0])}],rowCount:1};
    if(sql.startsWith('UPDATE silicon_genesis.life_state')){state=JSON.parse(params[2]);return {rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE silicon_genesis.outbox')){const row=rows.get(params[0]);row.state=sql.includes("SET state='dispatched'")?'dispatched':params[1];return {rows:[{action_id:row.action_id}],rowCount:1};}
    return {rows:[],rowCount:0};
  }})};
  let releaseFirst;const firstReceipt=new Promise(resolve=>{releaseFirst=resolve}),sequence=[];
  const executors=new Map([['first',async()=>{sequence.push('first-start');await firstReceipt;sequence.push('first-end');return {status:'completed',evidence:{}};}],['second',async()=>{sequence.push('second-start');return {status:'completed',evidence:{}};}]]);
  const lifecycle={prepare(){return {allowed:true}},complete(){},reconcile(){}};
  const dispatcher=new OutboxDispatcher(pool,executors,gate,lifecycle,new Map());
  try{
    const a=dispatcher.dispatch('first');await new Promise(setImmediate);
    const b=dispatcher.dispatch('second');await new Promise(setImmediate);
    assert.deepEqual(sequence,['first-start']);assert.equal(rows.get('second').state,'pending');
    releaseFirst();await Promise.all([a,b]);assert.deepEqual(sequence,['first-start','first-end','second-start']);assert.equal(rows.get('second').state,'completed');
  }finally{releaseFirst();await gate.close();}
});
