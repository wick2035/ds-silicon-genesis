import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readMemeChoices,withMemeSpeech} from '../dist/host/meme-speech.js';
import {validateActionParameters} from '../dist/host/action-parameters.js';

const pool=[{name:'可爱',desc:'开心问候'},{name:'吃饱饱摸肚子',desc:'吃饱满足'}];
const options={system:'角色',embodied:{petId:'main'},messages:[]};
async function collect(parts,opts=options,source=async()=>pool){
  let input;
  const model={async *stream(o){input=o;for(const part of parts)yield typeof part==='string'?{type:'text',text:part}:part;}};
  const output=[];for await(const part of withMemeSpeech(model,source).stream(opts))output.push(part);
  return {text:output.filter(p=>p.type==='text').map(p=>p.text).join(''),meme:output.find(p=>p.type==='meme')?.name,output,input};
}
test('split selection tags stay out of text and the selected image is allowlisted',async()=>{
  const r=await collect(['你好呀！[','图','：可','爱',']']);
  assert.equal(r.text,'你好呀！');assert.equal(r.meme,'可爱');
  assert.match(r.input.system,/也可以完全不配图/);
  assert.equal(r.output.filter(p=>p.type==='text').some(p=>p.text.includes('[图')),false);
});
test('no image is a valid choice; arbitrary brackets and structured calls remain intact',async()=>{
  const call={type:'tool-call-delta',index:1,argumentsDelta:'{}'};
  const r=await collect(['可以[愿意去工地]，也可以安静。',call,{type:'usage',inputTokens:10}]);
  assert.equal(r.text,'可以[愿意去工地]，也可以安静。');assert.equal(r.meme,undefined);
  assert.ok(r.output.includes(call));assert.equal(r.output.at(-1).inputTokens,10);
});
test('unknown, path-like, disabled and incomplete selections never appear as images or tags',async()=>{
  for(const tag of ['[图:不存在]','[图:../secret]','[图:可爱','[图']){
    const r=await collect(['你好',tag]);assert.equal(r.text,'你好');assert.equal(r.meme,undefined);
  }
  const r=await collect(['你好[图:可爱]'],options,async()=>[]);
  assert.equal(r.text,'你好');assert.equal(r.meme,undefined);
});
test('tool reset discards the earlier selection and text buffer',async()=>{
  const r=await collect(['草稿[图:可爱]',{type:'text-reset'},'最后只说晚安。']);
  assert.equal(r.meme,undefined);assert.ok(r.output.some(p=>p.type==='text-reset'));
});
test('forced whisper image uses its own pool and excludes other choices',async()=>{
  const modes=[];const source=async(id,mode)=>{assert.equal(id,'main');modes.push(mode);return pool;};
  const r=await collect(['好呀[图:吃饱饱摸肚子]'],{...options,memeMode:'whisper',memeImage:'可爱'},source);
  assert.equal(r.meme,undefined);assert.doesNotMatch(r.input.system,/吃饱饱摸肚子/);assert.deepEqual(modes,['whisper']);
});
test('changes to the pool during generation prevent publishing removed images',async()=>{
  let reads=0;const r=await collect(['你好[图:可爱]'],options,async()=>++reads===1?pool:[]);
  assert.equal(r.meme,undefined);
});
test('non-speech model JSON passes through without any meme prompt',async()=>{
  const r=await collect(['{"text":"[图:可爱]"}'],{system:'JSON',messages:[]},async()=>{throw Error('must not read pool');});
  assert.equal(r.text,'{"text":"[图:可爱]"}');assert.equal(r.input.system,'JSON');
});
test('pool follows enable flags, order, limit, file existence and symlink containment',async()=>{
  const root=await mkdtemp(join(tmpdir(),'silicon-memes-'));
  try{
    const dir=join(root,'memes');await mkdir(dir);await writeFile(join(dir,'可爱.png'),'fixture');await writeFile(join(dir,'吃饱饱摸肚子.png'),'fixture');
    const conf={memes:Object.fromEntries([...pool.map(m=>[m.name,m.desc]),['missing','missing'],['../outside','unsafe'],['empty','']]),chatImageEnabled:true,whisperImageEnabled:true,chatImageLimit:1};
    assert.deepEqual(await readMemeChoices(conf,[dir],'chat'),pool.slice(0,1));
    assert.deepEqual(await readMemeChoices(conf,[dir],'whisper'),pool);
    assert.deepEqual(await readMemeChoices({...conf,chatImageLimit:0},[dir],'chat'),pool);
    assert.deepEqual(await readMemeChoices({...conf,chatImageEnabled:false},[dir],'chat'),[]);
    await writeFile(join(root,'outside.png'),'outside');
    try{await symlink(join(root,'outside.png'),join(dir,'escape.png'));assert.deepEqual(await readMemeChoices({...conf,memes:{escape:'outside'}},[dir],'chat'),[]);}catch(e){if(e.code!=='EPERM')throw e;}
  }finally{await rm(root,{recursive:true,force:true});}
});
test('autonomous expressions accept an optional bounded meme name',()=>{
  assert.doesNotThrow(()=>validateActionParameters('self.express',{text:'你好',meme:'可爱'}));
  assert.doesNotThrow(()=>validateActionParameters('self.express',{text:'你好'}));
  assert.throws(()=>validateActionParameters('self.express',{text:'你好',meme:'../secret'}));
  assert.throws(()=>validateActionParameters('self.express',{text:'你好',meme:7}));
});

test('autonomous expression receipts preserve the validated image in conversation history',async()=>{
  const {projectOutcome}=await import('../dist/host/outcome-projector.js');
  const draft={petId:'main',legacy:{},humanity:{},life:{events:[]}};
  projectOutcome(draft,{id:'expression-1',type:'self.express',payload:{parameters:{text:'爸爸来啦！',meme:'可爱'}}},
    {status:'completed',evidence:{actionId:'expression-1',kind:'self.express',confirmed:true,meme:'可爱'}},new Date().toISOString(),'source-1');
  assert.equal(draft.life.events[0].payload.meme,'可爱');
  assert.equal(draft.life.events[0].payload.text,'爸爸来啦！');
});


test('chat persists the selected meme with plain text and restores it on duplicate requests',async()=>{
  const {CompanionStore}=await import('../vendor/pet-plugins/behavior/core.mjs');
  const {CanonicalChat}=await import('../dist/host/chat-service.js');
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  let state={petId:'main',version:0,legacy:old.read('main'),humanity:{},life:{actions:[],events:[],invalidSources:{},relationships:[],constraints:{permissions:[],capabilities:[]},memories:[],commitments:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const reader={loadEnvelope:async()=>structuredClone(state),load:async()=>structuredClone(state.life)};
  const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);fn(state);state.version++;}};
  let calls=0;const llm=withMemeSpeech({async *stream(){calls++;yield {type:'text',text:'你好呀！[图:可爱]'};}},async()=>pool);
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm};
  const chat=new CanonicalChat(reader,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[]);
  const selected=[],input={requestId:'meme-chat',petId:'main',channel:'desktop',actorId:'dad',text:'你好',onMeme:name=>selected.push(name)};
  assert.equal(await chat.turn(input,gate.signal),'你好呀！');
  const event=state.life.events.find(e=>e.type==='conversation.assistant');
  assert.equal(event.payload.meme,'可爱');assert.equal(event.payload.text,'你好呀！');
  assert.equal(await chat.turn(input,gate.signal),'你好呀！');assert.deepEqual(selected,['可爱','可爱']);assert.equal(calls,1);
});
