// Same-origin host API. The host is responsible for authentication and CSRF checks.
const fragment = new URLSearchParams(location.hash.slice(1));
const initialToken = fragment.get('token');
if (initialToken && /^[A-Za-z0-9_-]{43}$/.test(initialToken)) {
  sessionStorage.setItem('life-token',initialToken);
  history.replaceState(null,'',location.pathname+location.search);
}
async function fetchResult(url, options = {}) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),120000);
  try {
    const response=await fetch(url,{credentials:'same-origin',...options,signal:controller.signal});
    const data=await response.json().catch(()=>null);
    if(!response.ok||!data?.ok)throw Error(data?.error||data?.message||`生命系统请求失败 (${response.status})`);
    return data;
  } catch(error) {
    if(controller.signal.aborted)throw Error(options.method==='POST'?'等待反馈超时，操作结果尚未确认。请先刷新状态，避免重复操作。':'读取超时，请检查连接后刷新。');
    throw error;
  } finally {clearTimeout(timer);}
}
async function request(route, options = {}) {
  const token=sessionStorage.getItem('life-token');
  const headers=new Headers(options.headers || {});
  if(token) headers.set('x-dsh-pet-token',token);
  return (await fetchResult(`/api/life/${route}`,{...options,headers})).value;
}
window.lifeApi = Object.freeze({
  chat: async (text, requestId, attachments = []) => { const token=sessionStorage.getItem('life-token'); const headers={'content-type':'application/json'}; if(token) headers['x-dsh-pet-token']=token; const data=await fetchResult('/api/life/chat',{method:'POST',headers,body:JSON.stringify({text,requestId,attachments})}); return data.reply; },
  uploadImage: file => request('attachment', {method:'POST',headers:{'content-type':file.type,'x-request-id':crypto.randomUUID()},body:file}),
  shutdown: () => request('shutdown', {method:'POST'}),
  openWorksite: () => request('worksite', {method:'POST'}),
  getSnapshot: () => request('snapshot'),
  getGoals: () => request('goals'),
  getTimeline: () => request('timeline'),
  getRelationships: () => request('relationships'),
  getGrowth: () => request('growth'),
  searchMemories: query => request('memory-search?q='+encodeURIComponent(query)),
  getSettings: () => request('settings'),
  getFinance: () => request('finance'),
  updateFinance: input => request('finance', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input)}),
  getCompanion: () => request('companion'),
  updateCompanion: input => request('companion', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input)}),
  getModel: () => request('model'),
  updateModel: input => request('model', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input)}),
  manage: command => request('manage', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(command) })
});

// Establish the host's same-origin session cookie before importing modules.
// Module requests cannot attach the token header themselves.
void (async()=>{
  try {
    await window.lifeApi.getSnapshot();
    await import('./app.js');
  } catch(error) {
    document.querySelector('#connection').textContent='连接不可用';
    document.querySelector('#connection-detail').textContent='请重新从桌宠打开';
    const notice=document.querySelector('#notice');notice.textContent=error?.message||'无法连接生命系统，请重新从桌宠打开。';notice.hidden=false;
  }
})();
