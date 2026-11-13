import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseBodyReply } from './embodiment.mjs';
import { parseFeelingReply } from './conversation.mjs';
import { redactDadNames, sanitizeMemoryData } from './memory-privacy.mjs';

// Read the same live wallet as the pet. Freezing costs never makes zero positive.
export function attachCommunication(Runtime) {
  Runtime.prototype.redactDadNames = redactDadNames;
  Runtime.prototype.sanitizeMemoryData = sanitizeMemoryData;
  const old = Object.fromEntries(['observe', 'publish', 'reactToEvent', 'painReaction'].map(key => [key, Runtime.prototype[key]]));
  // A separate durable journal avoids changing the companion database schema.
  Runtime.prototype.speechGate = function(id) {
    const file=path.join(this.store.root,'empty-speech-gate.json');
    try { return {file,data:JSON.parse(fs.readFileSync(file,'utf8'))}; }
    catch(e) { if(e.code==='ENOENT') return {file,data:{}}; throw e; }
  };
  Runtime.prototype.speechAllowed = function() { return !this.disposed; };
  Runtime.prototype.proactiveAllowed = function(id) {
    if(this.disposed) return false;
    if(this.store.read(id).wallet.balance>0) return true;
    try { const last=this.speechGate(id).data[id]?.at; return !Number.isFinite(last) || this.store.clock()-last>=5*3600000; } catch { return false; }
  };
  Runtime.prototype.claimSpeech = function(id) {
    if(!this.proactiveAllowed(id)) return {ok:false};
    if(this.store.read(id).wallet.balance>0) return {ok:true};
    const {file,data}=this.speechGate(id), token=randomUUID();
    data[id]={at:this.store.clock(),token}; fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(data),{mode:0o600}); fs.renameSync(tmp,file);
    return {ok:true,token};
  };
  Runtime.prototype.validSpeechPermit = function(id,token) {
    if(!token || this.disposed) return false;
    try { const item=this.speechGate(id).data[id]; return item?.token===token && this.store.clock()-item.at<60000; } catch { return false; }
  };
  Runtime.prototype.singleSentence = value => {
    const text=String(value ?? '').trim().replace(/\r\n?/g,'\n');
    const match=text.match(/^[\s\S]*?(?:[。！？!?；;]|\.(?=\s|$)|\n)/u);
    return (match ? match[0] : text).trim();
  };
  Runtime.prototype.previewSpeech = value => parseFeelingReply(parseBodyReply(value).text).text;
  Runtime.prototype.observe = function(id, leaf, data) {
    if (leaf === 'say' && data?.text && !data.chatRecord && !this.proactiveAllowed(id) && !this.validSpeechPermit(id,data.speechPermit)) return false;
    return old.observe.call(this, id, leaf, data);
  };
  Runtime.prototype.publish = function(id, ...args) {
    if (this.proactiveAllowed(id)) return old.publish.call(this, id, ...args);
  };
  Runtime.prototype.reactToEvent = function(id, ...args) {
    if (!this.proactiveAllowed(id)) return Promise.reject(Error('饭钱已用尽，暂停发言'));
    return old.reactToEvent.call(this, id, ...args);
  };
  Runtime.prototype.painReaction = function(id, ...args) {
    if (this.store.read(id).wallet.balance>0 && this.speechAllowed(id)) return old.painReaction.call(this, id, ...args);
  };
}
