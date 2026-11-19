// Exercises the actual configured PostgreSQL state inside an outer transaction.
// All domain commits become savepoints and the transaction is always rolled back.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {UnitOfWork} from '../dist/storage/uow.js';
import {LegacyDomain} from '../dist/host/legacy-domain.js';
import {CanonicalHumanityAdapter} from '../dist/host/humanity-adapter.js';
import {createLegacyRequestAdapter} from '../dist/host/legacy-request-adapter.js';
import {createCompanionManagement} from '../dist/host/companion-management.js';
import {createLifeApi} from '../dist/host/life-api.js';

const cfg=JSON.parse(await readFile('data/dsh/dsh-pet/companion/postgres.json','utf8'));
const pool=new pg.Pool({...cfg.connection,application_name:'codex-companion-rollback-check',connectionTimeoutMillis:5000});
const client=await pool.connect();let locked=false,transaction=false;
try {
  locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended('silicon_genesis:writer',0)) AS ok")).rows[0].ok;
  if(!locked)throw Error('生命系统正在运行，无法取得写入租约；未执行写入测试');
  const rows=await client.query('SELECT pet_id,version::text,payload FROM silicon_genesis.life_state ORDER BY pet_id');
  const row=rows.rows.find(x=>x.pet_id==='main')||(rows.rows.length===1?rows.rows[0]:null);if(!row)throw Error('未找到唯一宠物');
  const id=row.pet_id,original=createHash('sha256').update(JSON.stringify(row.payload)).digest('hex');
  await client.query('BEGIN');transaction=true;
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const reader={loadEnvelope:async petId=>(await client.query('SELECT payload FROM silicon_genesis.life_state WHERE pet_id=$1',[petId])).rows[0]?.payload||null};
  const wrapped={connect:async()=>({query:async(sql,values)=>client.query(sql==='BEGIN'?'SAVEPOINT companion_check':sql==='COMMIT'?'RELEASE SAVEPOINT companion_check':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT companion_check':sql,values),release(){}})};
  const uow=new UnitOfWork(wrapped,gate),domain=new LegacyDomain(reader,uow,gate,{}),humanity=new CanonicalHumanityAdapter(reader,uow,gate,{},{});
  const adapter=createLegacyRequestAdapter({store:reader,gate,domain,humanity,resolvePet:()=>({petId:id,name:'大肥鱼'})});
  const companion=createCompanionManagement(adapter,domain,()=>{},reader.loadEnvelope),api=createLifeApi({authorize:()=>true,petId:()=>id,getState:async()=>{throw Error('unexpected read')},companion});
  const get=async()=>{const r=await api(new Request('http://localhost/api/life/companion'));assert.equal(r.status,200);return (await r.json()).value};
  const post=async(input,expected=200)=>{const r=await api(new Request('http://localhost/api/life/companion',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,requestId:randomUUID()})}));const body=await r.json();assert.equal(r.status,expected,body.error);return body};
  const before=await get();
  await post({operation:'adjust',stats:{pain:Math.max(0,Math.min(100,Math.round(before.body.stats.pain)+1))},expectedRevision:before.body.adjustmentRevision||0});
  await post({operation:'adjust',stats:{pain:50},expectedRevision:before.body.adjustmentRevision||0},409);
  await post({operation:'network',enabled:true});await post({operation:'ability',ability:'search',action:'grant'});
  assert.ok((await reader.loadEnvelope(id)).life.constraints.permissions.includes('network'));
  await post({operation:'network',enabled:false});assert.ok(!(await reader.loadEnvelope(id)).life.constraints.permissions.includes('network'));
  await post({operation:'config',intelligenceEnabled:true,intelligence:71,diaryEnabled:true});
  await post({operation:'wish',action:'add',topic:'回滚验证专用念想',ability:'search'});
  let current=await get();const wish=current.wishes.find(w=>w.topic==='回滚验证专用念想');assert.ok(wish);
  await post({operation:'wish',action:'dismiss',id:wish.id});
  await post({operation:'memory',action:'add',text:'回滚验证专用记忆'});
  const diary=Object.entries(current.diaries||{}).find(([,d])=>typeof d.text==='string'&&d.text.length>0);
  if(diary){await post({operation:'diary',action:'edit',date:diary[0],text:'回滚验证专用日记',expectedText:diary[1].text});await post({operation:'diary',action:'delete',date:diary[0],expectedText:diary[1].text},409);}
  await post({operation:'growth',action:'freeze',frozen:true});
  current=await get();assert.equal(current.persona.frozen,true);
  const care=await api(new Request('http://localhost/api/life/companion',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'care',action:'water',requestId:randomUUID()})}));
  const careResult=await care.json();assert.ok(care.status===200 || care.status===409 && typeof careResult.error==='string');
  await client.query('ROLLBACK');transaction=false;
  const restored=(await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1',[id])).rows[0];
  assert.equal(restored.version,row.version);assert.equal(createHash('sha256').update(JSON.stringify(restored.payload)).digest('hex'),original);
  console.log('真实 PostgreSQL 验证通过：身体调整及冲突、联网与授权、成长设置、念想、记忆、日记、人格冻结；事务已回滚，状态未变化。');
} finally {
  if(transaction)await client.query('ROLLBACK').catch(()=>{});
  if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended('silicon_genesis:writer',0))").catch(()=>{});
  client.release();await pool.end();
}
