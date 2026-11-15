import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createLifeRoutes} from '../dist/host/life-routes.js';
import {createLifeApi} from '../dist/host/life-api.js';
import {createRequestSecurity,listenStandaloneServer} from '../vendor/dsh-pet/lib/silicon-host.js';

test('authenticated image uploads keep the 5 MB limit through the outer host',async t=>{
  const security=createRequestSecurity(),stored=[];
  const api=createLifeApi({authorize:()=>true,petId:()=> 'main',attachments:{
    async put(petId,requestId,input){stored.push(input.data);return {petId,id:'image:test',sourceEventId:requestId};}
  }});
  const server=await listenStandaloneServer({port:0,security,routes:createLifeRoutes(process.cwd(),api),logger:{debug(){},info(){},warn(){},error(){}}});
  t.after(()=>server.close());
  const send=(path,size,{chunked=false,authenticated=true}={})=>new Promise((resolve,reject)=>{
    const data=Buffer.alloc(size,42);Buffer.from([137,80,78,71,13,10,26,10]).copy(data);
    const headers={'content-type':'image/png','x-request-id':'upload-request-123',...(authenticated?{'x-dsh-pet-token':security.token}:{}),...(chunked?{}:{'content-length':size})};
    const req=httpRequest({hostname:'127.0.0.1',port:server.port,path,method:'POST',headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });
    req.on('error',reject);
    if(chunked){req.write(data.subarray(0,Math.floor(size/2)));req.end(data.subarray(Math.floor(size/2)));}else req.end(data);
  });
  for(const [size,chunked] of [[1_048_577,false],[5_000_000,false],[5_000_000,true]]){
    const reply=await send('/api/life/attachment',size,{chunked});
    assert.equal(reply.status,200,reply.body);
    assert.equal(stored.at(-1).length,size);
    assert.equal(stored.at(-1)[size-1],42);
  }
  for(const chunked of [false,true])assert.equal((await send('/api/life/attachment',5_000_001,{chunked})).status,413);
  assert.equal((await send('/api/life/attachment',1_048_577,{authenticated:false})).status,403);
  assert.equal((await send('/api/life/manage',1_048_577)).status,413);
  assert.equal((await send('/standalone-ai/settings',16_385)).status,413);
  assert.equal(stored.length,3);
});
