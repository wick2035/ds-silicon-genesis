import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('open chat refreshes from the dedicated history and leaves pending replies in place',async()=>{
  const source=await readFile(new URL('../src/ui/app.js',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('function chatMessageMarkup('),source.indexOf('function chatPanel('));
  const sync=source.slice(source.indexOf('async function syncOpenChat()'),source.indexOf('setInterval(()=>{void syncOpenChat()},5000);'));
  const history=[{id:'a',role:'user',text:'desktop'},{id:'b',role:'assistant',text:'qq-private'}];
  const messages={innerHTML:'',scrollHeight:100,scrollTop:30,clientHeight:70};
  const context={document:{hidden:false},page:'chat',chatSending:false,chatSyncing:false,requestId:1,chatSyncedSignature:'',
    refresh:{disabled:false},pageCache:new Map(),view:{querySelector:()=>messages},window:{lifeApi:{getChatHistory:async()=>history}},esc:String,date:String};
  await runInNewContext(helpers+'\n'+sync+'\nsyncOpenChat()',context);
  assert.match(messages.innerHTML,/desktop/);assert.match(messages.innerHTML,/qq-private/);
  assert.equal(context.pageCache.get('chat'),history);
  assert.equal(messages.scrollTop,100);
  context.chatSending=true;messages.innerHTML='pending message';
  await runInNewContext('syncOpenChat()',context);
  assert.equal(messages.innerHTML,'pending message');
});
