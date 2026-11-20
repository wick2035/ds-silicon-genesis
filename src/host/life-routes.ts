import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

type Handler = (request: Request) => Promise<Response | undefined>;
type Route = {kind:'exact'|'prefix';path:string;handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>};

/** Routes for the standalone server. Install only behind its existing local
 * token/origin guard; the API's authorize callback may then trust that guard.
 * Fixed assets avoid turning this into a general filesystem endpoint. */
export function createLifeRoutes(root: string, api: Handler): Route[] {
  const assets: Record<string,[string,string]> = {
    '/life/':['src/ui/index.html','text/html; charset=utf-8'],
    '/life/style.css':['src/ui/style.css','text/css; charset=utf-8'],
    '/life/bridge.js':['src/ui/bridge.js','text/javascript; charset=utf-8'],
    '/life/app.js':['src/ui/app.js','text/javascript; charset=utf-8'],
    '/life/finance.js':['src/ui/finance.js','text/javascript; charset=utf-8'],
    '/life/companion.js':['src/ui/companion.js','text/javascript; charset=utf-8'],
    '/life/model.js':['src/ui/model.js','text/javascript; charset=utf-8'],
    '/life/memory-graph.js':['src/ui/memory-graph.js','text/javascript; charset=utf-8'],
    '/life/group-people.js':['src/ui/group-people.js','text/javascript; charset=utf-8'],
    '/assets/main-character.png':['vendor/dsh-pet/assets/main-character.png','image/png']
  };
  const asset = async(req:IncomingMessage,res:ServerResponse) => {
    const pathname=new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const spec=assets[pathname];
    if(!spec){res.writeHead(404);res.end();return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    try {const data=await readFile(join(root,spec[0]));res.writeHead(200,{'content-type':spec[1],'content-length':data.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);}
    catch {res.writeHead(404);res.end();}
  };
  const apiRoute = async(req:IncomingMessage,res:ServerResponse) => {
    const cancel=new AbortController();
    req.once('aborted',()=>cancel.abort());
    res.once('close',()=>{if(!res.writableFinished)cancel.abort();});
    const chunks:Buffer[]=[];let size=0;
    const upload=new URL(req.url||'/', 'http://127.0.0.1').pathname==='/api/life/attachment' && req.method==='POST';
    const limit=upload?5_000_000:8192;
    for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=part.length;if(size>limit){res.writeHead(413);res.end();return;}chunks.push(part);}
    const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
    const method=req.method || 'GET';
    const request=new Request(new URL(req.url || '/',`http://127.0.0.1:${req.socket.localPort}`).href,{method,headers,signal:cancel.signal,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})});
    const reply=await api(request);
    if(!reply){res.writeHead(404);res.end();return;}
    const responseHeaders:Record<string,string>={};reply.headers.forEach((value,name)=>{responseHeaders[name]=value;});
    res.writeHead(reply.status,responseHeaders);
    if(reply.headers.get('content-type')?.includes('text/event-stream') && reply.body){
      res.flushHeaders();const reader=reply.body.getReader();
      try{while(!cancel.signal.aborted){const {done,value}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await new Promise<void>(resolve=>{res.once('drain',resolve);res.once('close',resolve);});}}finally{await reader.cancel().catch(()=>{});res.end();}
    }else res.end(Buffer.from(await reply.arrayBuffer()));
  };
  return [{kind:'prefix',path:'/life',handler:asset},{kind:'exact',path:'/assets/main-character.png',handler:asset},{kind:'prefix',path:'/api/life',handler:apiRoute},{kind:'exact',path:'/dsh-pet-7340/attachment',handler:apiRoute}];
}
