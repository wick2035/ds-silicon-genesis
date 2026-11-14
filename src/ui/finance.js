const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(v):'暂不可用';
const date=v=>{const d=new Date(v);return Number.isNaN(d.valueOf())?'时间未知':d.toLocaleString('zh-CN',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
const costLabels={chat:'聊天',whisper:'碎碎念',feed:'喂一口饭',diary:'整理与日记',explore:'一次探索'};
const stateLabels={offered:'商量中',working:'工作中',paused:'已暂停',unpaid:'等待结薪',paid:'已结清',declined:'已取消'};
let current=null,pending=null,busy=false;

export function renderFinance(data){
  current=data;
  const w=data?.wallet,c=data?.labor?.current,history=data?.labor?.history||[],events=data?.events||[];
  if(!w||!Number.isFinite(w.balance)||typeof w.frozen!=='boolean'||!data.costs)return '<div class="grid"><section class="card full"><h2>饭钱暂不可用</h2><p>请刷新后重试。</p></section></div>';
  const field=(key,label)=>`<label>${label}<span class="price-input"><input name="${key}" type="number" min="0" max="100000" step="0.01" required value="${esc(data.costs[key])}"><span>token</span></span></label>`;
  const action=(a,label)=>`<button type="button" class="secondary" data-finance-action="${a}" data-id="${esc(c.id)}">${label}</button>`;
  const contract=c?`<div class="contract-head"><div><span class="tag">${esc(stateLabels[c.status]||c.status)}</span><h3>${esc(c.trips)} 趟 · ${fmt(c.wage)} token</h3><p>已完成 ${esc(c.done)} / ${esc(c.trips)} 趟 · 已支付 ${fmt(c.paid)} token</p></div></div>
    <p class="finance-note">${esc(c.status==='offered'?(c.accepted?'她已答应，确认后开工。':c.counter?`她提出 ${c.counter.trips} 趟 / ${fmt(c.counter.wage)} token。`:'等待她回应，可以在聊天里继续商量。'):c.status==='unpaid'?`还差 ${fmt(Math.max(0,c.wage-c.paid))} token，完成后由你手动结算。`:c.status==='paused'?'进度已保留，可以随时继续。':data.labor.execution?.message||'实际放下砖才计入进度。')}</p>
    <div class="entry-actions">${c.status==='offered'&&c.accepted?action('confirm','确认开工'):''}${c.status==='offered'&&c.counter?action('counter','接受还价'):''}${c.status==='offered'?action('decline','取消约定'):''}${(c.status==='working'||c.status==='offered'&&!c.accepted&&!c.counter)?action('nudge',c.status==='offered'?'请她回应':'继续搬砖'):''}${c.status==='working'?action('pause','暂停工作'):''}${c.status==='paused'?action('resume','继续工作'):''}</div>
    ${c.status==='unpaid'?`<form id="labor-pay-form" class="finance-form"><label>本次支付 <span class="price-input"><input name="amount" type="number" min="0" max="1000000" step="1" value="${esc(Math.max(0,c.wage-c.paid))}" required><span>token</span></span></label><button class="primary">支付工钱</button></form>`:''}`:'<p class="finance-note">目前没有进行中的工作约定。可以在聊天里商量，或在这里提出条件。</p>';
  return `<div class="grid finance-grid">
    <section class="card full finance-balance"><div><h2>模拟饭钱余额</h2><div class="balance-number">${fmt(w.balance)} <span>token</span></div><p class="finance-note">用于她的生活和互动，与模型服务商的真实余额无关。</p></div><div class="freeze-control"><strong>${w.frozen?'日常消耗已冻结':'日常消耗进行中'}</strong><p>冻结后日常消费不扣饭钱，抖落的钱仍会扣除。</p><button type="button" class="secondary" data-finance-action="freeze">${w.frozen?'恢复日常消耗':'冻结日常消耗'}</button></div></section>
    <section class="card two-thirds"><h2>调整余额</h2><p class="finance-note">增加、减少或直接设置余额；最多保留两位小数。</p><form id="wallet-form" class="finance-form"><label>操作<select name="action"><option value="add">增加</option><option value="subtract">减少</option><option value="set">设为</option></select></label><label>金额<span class="price-input"><input name="amount" type="number" min="0" max="1000000000" step="0.01" required placeholder="输入金额"><span>token</span></span></label><button class="primary">更新余额</button></form><p class="finance-feedback" role="status"></p></section>
    <section class="card third"><h2>工作约定</h2>${contract}<form id="labor-offer-form" class="offer-form" ${c&&c.status!=='offered'?'hidden':''}><h3>${c?'调整约定':'提出工作'}</h3><div class="offer-fields"><label>趟数<input name="trips" type="number" min="1" max="50" step="1" value="${esc(c?.trips||1)}" required></label><label>总工钱<input name="wage" type="number" min="1" max="1000000" step="1" value="${esc(c?.wage||100)}" required></label></div><button class="secondary">${c?'重新提出':'提出约定'}</button></form><p class="finance-feedback" role="status"></p></section>
    <section class="card two-thirds"><h2>日常消费价格</h2><p class="finance-note">每次操作的模拟饭钱价格，可设为 0。</p><form id="cost-form"><div class="cost-fields">${Object.entries(costLabels).map(([k,v])=>field(k,v)).join('')}</div><button class="primary">保存价格</button></form><p class="finance-feedback" role="status"></p></section>
    <section class="card third"><h2>工作历史</h2>${history.length?`<div class="finance-list">${history.map(x=>`<div><strong>${esc(x.trips)} 趟 · ${fmt(x.paid)} token</strong><span>${esc(stateLabels[x.status]||x.status)} · 约定 ${fmt(x.wage)}</span></div>`).join('')}</div>`:'<p class="finance-note">还没有完成或取消的约定。</p>'}</section>
    <section class="card full"><h2>近期饭钱与工钱操作</h2><p class="finance-note">这里显示已记录的调整和工作事件；不代表完整消费流水。</p>${events.length?`<div class="finance-list">${events.map(e=>`<div><strong>${esc(e.text)}</strong><span>${esc(date(e.ts))}</span></div>`).join('')}</div>`:'<p class="finance-note">还没有相关操作记录。</p>'}</section>
  </div>`;
}

export function installFinance(view,reload,isActive){
  async function send(input,feedback){
    if(busy)return;busy=true;
    const signature=JSON.stringify(input);if(!pending||pending.signature!==signature)pending={signature,id:crypto.randomUUID()};
    const controls=view.querySelectorAll('button,input,select');controls.forEach(el=>el.disabled=true);
    feedback.textContent='正在保存…';
    try{await window.lifeApi.updateFinance({...input,requestId:pending.id});pending=null;if(isActive()){await reload();const target=view.querySelector('.finance-feedback');if(target)target.textContent='已保存。';}}
    catch(error){feedback.textContent=(error?.message||'保存失败')+'；可检查后重试。';}
    finally{busy=false;controls.forEach(el=>el.disabled=false);}
  }
  view.addEventListener('submit',event=>{
    const form=event.target;if(!['wallet-form','cost-form','labor-offer-form','labor-pay-form'].includes(form.id))return;
    event.preventDefault();if(!current||busy)return;const f=new FormData(form),feedback=form.closest('.card').querySelector('.finance-feedback');let input;
    if(form.id==='wallet-form')input={kind:'wallet',action:f.get('action'),amount:Number(f.get('amount')),expectedBalance:current.wallet.balance,expectedFrozen:current.wallet.frozen};
    else if(form.id==='cost-form')input={kind:'costs',costs:Object.fromEntries(Object.keys(costLabels).map(k=>[k,Number(f.get(k))]))};
    else if(form.id==='labor-offer-form')input={kind:'labor',action:'offer',trips:Number(f.get('trips')),wage:Number(f.get('wage'))};
    else input={kind:'labor',action:'pay',id:current.labor.current.id,amount:Number(f.get('amount'))};
    void send(input,feedback);
  });
  view.addEventListener('click',event=>{
    const button=event.target.closest('[data-finance-action]');if(!button||!current||busy)return;
    const action=button.dataset.financeAction,input=action==='freeze'?{kind:'wallet',action,frozen:!current.wallet.frozen,expectedBalance:current.wallet.balance,expectedFrozen:current.wallet.frozen}:{kind:'labor',action,id:button.dataset.id};
    const feedback=button.closest('.card').querySelector('.finance-feedback')||view.querySelector('.finance-feedback');void send(input,feedback);
  });
}
