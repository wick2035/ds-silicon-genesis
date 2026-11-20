import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join} from 'node:path';

/** A single local worker; timed-out replies are ignored and never sent to a remote service. */
export class LocalReranker {
  private child?:ChildProcessWithoutNullStreams;
  private ready=false;
  private serial=0;
  private pending=new Map<number,{resolve:(scores:number[]|null)=>void;timer:NodeJS.Timeout}>();
  constructor(root:string,signal:AbortSignal){
    const child=spawn(process.env.SILICON_RERANK_PYTHON||'python',[join(root,'tools','sag2-reranker.py'),join(root,'data','models','qwen3-reranker-0.6b')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});
    this.child=child;child.stderr.resume();
    const startup=setTimeout(()=>{if(!this.ready)this.close();},30000);startup.unref();
    createInterface({input:child.stdout}).on('line',line=>{try{const msg=JSON.parse(line);if(typeof msg.ready==='boolean'){clearTimeout(startup);this.ready=msg.ready;return;}const item=this.pending.get(msg.id);if(!item)return;clearTimeout(item.timer);this.pending.delete(msg.id);item.resolve(Array.isArray(msg.scores)&&msg.scores.every(Number.isFinite)?msg.scores:null);}catch{/* invalid worker output */}});
    const stop=()=>{clearTimeout(startup);this.ready=false;for(const item of this.pending.values()){clearTimeout(item.timer);item.resolve(null);}this.pending.clear();};
    child.on('error',stop);child.on('exit',stop);signal.addEventListener('abort',()=>this.close(),{once:true});
  }
  status(){return this.ready?'ready':'degraded';}
  async score(query:string,documents:string[],signal?:AbortSignal):Promise<number[]|null>{
    signal?.throwIfAborted();
    if(!this.ready||!this.child||this.pending.size||!documents.length)return null;
    const id=++this.serial;
    return new Promise(resolve=>{
      const finish=(value:number[]|null)=>{const item=this.pending.get(id);if(!item)return;clearTimeout(item.timer);this.pending.delete(id);signal?.removeEventListener('abort',abort);resolve(value);};
      const abort=()=>finish(null),timer=setTimeout(()=>finish(null),4000);
      this.pending.set(id,{resolve:value=>{signal?.removeEventListener('abort',abort);resolve(value);},timer});
      signal?.addEventListener('abort',abort,{once:true});
      this.child!.stdin.write(JSON.stringify({id,query,documents:documents.slice(0,24)})+'\n',error=>{if(error)finish(null);});
    });
  }
  close(){this.ready=false;this.child?.kill();this.child=undefined;}
}
