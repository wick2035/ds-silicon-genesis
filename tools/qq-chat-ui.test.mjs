import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('open chat refreshes owner messages without mixing in group conversations',async()=>{
  const source=await readFile(new URL('../src/ui/app.js',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('function ownerChatMessages('),source.indexOf('function chatPanel('));
  const sync=source.slice(source.indexOf('async function syncOpenChat()'),source.indexOf('setInterval(()=>{void syncOpenChat()},5000);'));
  const events=[{eventId:'a',type:'conversation.user',source:'desktop',payload:{text:'desktop'}},{eventId:'b',type:'conversation.assistant',source:'qq-c2c',payload:{text:'qq-private'}},{eventId:'c',type:'conversation.user',source:'qq-group',payload:{text:'group-message'}}];
  const messages={innerHTML:'',scrollHeight:100,scrollTop:30,clientHeight:70};
  const context={document:{hidden:false},page:'chat',chatSending:false,chatSyncing:false,requestId:1,chatSyncedSignature:'',view:{querySelector:()=>messages},window:{lifeApi:{getTimeline:async()=>events,getSnapshot:async()=>({sources:{a:{},b:{},c:{}}})}},esc:String,date:String};
  await runInNewContext(helpers+'\n'+sync+'\nsyncOpenChat()',context);
  assert.match(messages.innerHTML,/desktop/);assert.match(messages.innerHTML,/qq-private/);assert.doesNotMatch(messages.innerHTML,/group-message/);
  assert.equal(messages.scrollTop,100);
  context.chatSending=true;messages.innerHTML='pending message';
  await runInNewContext('syncOpenChat()',context);
  assert.equal(messages.innerHTML,'pending message');
});
