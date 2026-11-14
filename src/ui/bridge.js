// Same-origin host API. The host is responsible for authentication and CSRF checks.
const fragment = new URLSearchParams(location.hash.slice(1));
const initialToken = fragment.get('token');
if (initialToken && /^[A-Za-z0-9_-]{43}$/.test(initialToken)) {
  sessionStorage.setItem('life-token',initialToken);
  history.replaceState(null,'',location.pathname+location.search);
}
async function request(route, options = {}) {
  const token=sessionStorage.getItem('life-token');
  const headers=new Headers(options.headers || {});
  if(token) headers.set('x-dsh-pet-token',token);
  const response = await fetch(`/api/life/${route}`, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || `生命系统请求失败 (${response.status})`);
  return data.value;
}
window.lifeApi = Object.freeze({
  chat: async (text, requestId, attachments = []) => { const token=sessionStorage.getItem('life-token'); const headers={'content-type':'application/json'}; if(token) headers['x-dsh-pet-token']=token; const response=await fetch('/api/life/chat',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({text,requestId,attachments})}); const data=await response.json(); if(!response.ok || !data.ok) throw Error(data.error||'聊天暂时不可用'); return data.reply; },
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
