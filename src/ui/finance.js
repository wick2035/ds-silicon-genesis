const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(v):'暂不可用';
const date=v=>{const d=new Date(v);return Number.isNaN(d.valueOf())?'时间未知':d.toLocaleString('zh-CN',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
const costLabels={feed:'大白饭',riceSeed:'水稻种子（每束）',chat:'聊天',whisper:'碎碎念',diary:'日记',explore:'一次探索'};
const stateLabels={offered:'旧任务待处理',queued:'待开始',working:'工作中',paused:'已暂停',unpaid:'等待结薪',paid:'已结清',declined:'未接下',cancelled:'已取消'};
let current=null,pending=null,busy=false;

export function renderFinance(data){
  current=data;
  const w=data?.wallet,c=data?.labor?.current,history=data?.labor?.history||[],queue=data?.labor?.queue||[],events=data?.events||[];
  if(!w||!Number.isFinite(w.balance)||typeof w.frozen!=='boolean'||!data.costs)return '<div class="grid"><section class="card full"><h2>饭钱暂不可用</h2><p>请刷新后重试。</p></section></div>';
  const seeds=data.seedShop;
  const seedShop=seeds?`<section class="seed-shop" aria-labelledby="seed-shop-title"><h3 id="seed-shop-title">购买水稻种子</h3><p class="finance-note">库存 ${fmt(seeds.stock)} / ${fmt(seeds.limit)} 束 · 每季用 ${fmt(seeds.perSeason)} 束</p><p class="finance-note">${seeds.stock===seeds.limit?'库存已满，播种后可再购买。':seeds.maxPurchase<1?'饭钱不足，暂时无法购买。':`每束 ${fmt(seeds.charge)} token · 当前最多可买 ${fmt(seeds.maxPurchase)} 束`}</p>${seeds.maxPurchase>0?`<form id="seed-purchase-form" class="finance-form"><label>购买数量（束）<input name="count" type="number" min="1" max="${esc(seeds.maxPurchase)}" step="1" value="1" required></label><button class="secondary">购买种子<span> · ${fmt(seeds.charge)} token</span></button></form>`:''}<p class="seed-feedback finance-feedback" role="status"></p></section>`:'';
  const field=(key,label)=>`<label>${label}<span class="price-input"><input name="${key}" type="number" min="0" max="100000" step="0.01" required value="${esc(data.costs[key])}"><span>token</span></span></label>`;
  const action=(a,label)=>`<button type="button" class="secondary" data-finance-action="${a}" data-id="${esc(c.id)}">${label}</button>`;
  const contract=c?`<div class="contract-head"><div><span class="tag">${esc(stateLabels[c.status]||c.status)}</span><h3>${esc(c.trips)} 趟 · ${c.wageUnspecified?'工钱未填写':fmt(c.wage)+' token'}</h3><p>已完成 ${esc(c.done)} / ${esc(c.trips)} 趟 · 已支付 ${fmt(c.paid)} token</p></div></div>
    <p class="finance-note">${esc(c.status==='paused'?'任务已暂停，后续任务继续等待。':c.workPermit?data.labor.execution?.message||'实际放下砖才计入进度。':'任务已记录，她会根据自己的状态决定何时搬。')}</p>
    <div class="entry-actions">${action('cancel','取消任务')}${c.status==='working'?action('pause','暂停任务'):''}${c.status==='paused'?action('resume','恢复任务'):''}</div>
    <details><summary>调整当前任务</summary><form id="labor-adjust-form" class="offer-form"><div class="offer-fields"><label>趟数<input name="trips" type="number" min="${Math.max(1,c.done||0)}" max="500" step="1" value="${esc(c.trips)}" required></label><label>总工钱<input name="wage" type="number" min="1" max="1000000" step="1" value="${esc(c.wage)}" required></label></div><button class="secondary">保存调整</button></form></details>`:'<p class="finance-note">当前没有搬砖任务。</p>';
  const queued=queue.length?`<div class="finance-list labor-queue">${queue.map((x,i)=>`<div><strong>等待 ${i+1} · ${esc(x.trips)} 趟 · ${fmt(x.wage)} token</strong><span>已完成 ${esc(x.done||0)} 趟</span><button type="button" class="secondary" data-finance-action="cancel" data-id="${esc(x.id)}">取消此任务</button></div>`).join('')}</div>`:'<p class="finance-note">暂无排队任务。</p>';
  return `<div class="grid finance-grid">
    <section class="card full finance-balance"><div><h2>模拟饭钱余额</h2><div class="balance-number">${fmt(w.balance)} <span>token</span></div><p class="finance-note">用于她的生活和互动，与模型服务商的真实余额无关。</p></div><div class="freeze-control"><strong>${w.frozen?'日常消耗已冻结':'日常消耗进行中'}</strong><p>冻结后日常消费不扣饭钱，抖落的钱仍会扣除。</p><button type="button" class="secondary" data-finance-action="freeze">${w.frozen?'恢复日常消耗':'冻结日常消耗'}</button></div></section>
    <section class="card two-thirds"><h2>调整余额</h2><p class="finance-note">增加、减少或直接设置余额；最多保留两位小数。</p><form id="wallet-form" class="finance-form"><label>操作<select name="action"><option value="add">增加</option><option value="subtract">减少</option><option value="set">设为</option></select></label><label>金额<span class="price-input"><input name="amount" type="number" min="0" max="1000000000" step="0.01" required placeholder="输入金额"><span>token</span></span></label><button class="primary">更新余额</button></form><p class="finance-feedback" role="status"></p></section>
    <section class="card third"><h2>搬砖任务</h2>${contract}<form id="labor-offer-form" class="offer-form"><h3>新增任务</h3><div class="offer-fields"><label>趟数<input name="trips" type="number" min="1" max="500" step="1" value="1" required></label><label>总工钱<input name="wage" type="number" min="1" max="1000000" step="1" value="100" required></label></div><button class="primary">新增任务</button></form><h3>排队任务</h3>${queued}<p class="finance-feedback" role="status"></p></section>
    <section class="card two-thirds"><h2>日常消费价格</h2><p class="finance-note">模拟饭钱价格，可设为 0。</p><form id="cost-form"><div class="cost-fields">${Object.entries(costLabels).map(([k,v])=>field(k,v)).join('')}</div><button class="primary">保存价格</button></form><p class="finance-feedback" role="status"></p>${seedShop}</section>
    <section class="card third"><h2>工作历史</h2><p class="finance-note">工钱可以稍后逐笔支付；取消保留实际进度，不自动付款。</p>${history.length?`<div class="finance-list">${history.map(x=>`<div><strong>${esc(x.done||0)} / ${esc(x.trips)} 趟 · 已付 ${fmt(x.paid)} token</strong><span>${esc(stateLabels[x.status]||x.status)} · 约定 ${fmt(x.wage)}</span>${['cancelled','unpaid'].includes(x.status)?`<form data-history-payment="true" data-id="${esc(x.id)}" class="finance-form"><label>本次给多少<input name="amount" type="number" min="0" max="1000000" step="1" value="0" required></label><button class="secondary">记录付款</button></form>`:''}</div>`).join('')}</div>`:'<p class="finance-note">还没有完成或取消的约定。</p>'}<p class="finance-feedback" role="status"></p></section>
    <section class="card full"><h2>近期饭钱与工钱操作</h2><p class="finance-note">这里显示已记录的调整和工作事件；不代表完整消费流水。</p>${events.length?`<div class="finance-list">${events.map(e=>`<div><strong>${esc(e.text)}</strong><span>${esc(date(e.ts))}</span></div>`).join('')}</div>`:'<p class="finance-note">还没有相关操作记录。</p>'}</section>
  </div>`;
}

export function installFinance(view,reload,isActive){
  async function send(input,feedback){
    if(busy)return;busy=true;
    const signature=JSON.stringify(input);if(!pending||pending.signature!==signature)pending={signature,id:crypto.randomUUID()};
    const controls=view.querySelectorAll('button,input,select');controls.forEach(el=>el.disabled=true);
    feedback.textContent='正在保存…';
    try{await window.lifeApi.updateFinance({...input,requestId:pending.id});pending=null;if(isActive()){await reload();const target=view.querySelector(input.kind==='farm-seeds'?'.seed-feedback':input.kind==='costs'?'#cost-form + .finance-feedback':'.finance-feedback');if(target)target.textContent=input.kind==='farm-seeds'?`已买入 ${input.count} 束。`:'已保存。';}}
    catch(error){feedback.textContent=(error?.message||'保存失败')+'；可检查后重试。';}
    finally{busy=false;controls.forEach(el=>el.disabled=false);}
  }
  view.addEventListener('input',event=>{
    const input=event.target;
    if(input.name!=='count'||input.form?.id!=='seed-purchase-form')return;
    input.form.querySelector('button span').textContent=input.validity.valid?` · ${fmt(input.valueAsNumber*current.seedShop.charge)} token`:'';
  });
  view.addEventListener('submit',event=>{
    const form=event.target;if(!['wallet-form','cost-form','seed-purchase-form','labor-offer-form','labor-adjust-form','labor-pay-form'].includes(form.id)&&!form.dataset.historyPayment)return;
    event.preventDefault();if(!current||busy)return;const f=new FormData(form),feedback=form.closest(form.id==='seed-purchase-form'?'.seed-shop':'.card').querySelector('.finance-feedback');let input;
    if(form.id==='wallet-form')input={kind:'wallet',action:f.get('action'),amount:Number(f.get('amount')),expectedBalance:current.wallet.balance,expectedFrozen:current.wallet.frozen};
    else if(form.id==='cost-form')input={kind:'costs',costs:Object.fromEntries(Object.keys(costLabels).map(k=>[k,Number(f.get(k))]))};
    else if(form.id==='seed-purchase-form')input={kind:'farm-seeds',count:Number(f.get('count')),unitCharge:current.seedShop.charge};
    else if(form.id==='labor-offer-form'||form.id==='labor-adjust-form')input={kind:'labor',action:form.id==='labor-adjust-form'?'adjust':'offer',...(form.id==='labor-adjust-form'?{id:current.labor.current.id}:{}),trips:Number(f.get('trips')),wage:Number(f.get('wage'))};
    else input={kind:'labor',action:form.dataset.historyPayment==='true'?'settle-cancelled':'pay',id:form.dataset.historyPayment==='true'?form.dataset.id:current.labor.current.id,amount:Number(f.get('amount'))};
    void send(input,feedback);
  });
  view.addEventListener('click',event=>{
    const button=event.target.closest('[data-finance-action]');if(!button||!current||busy)return;
    const action=button.dataset.financeAction,input=action==='freeze'?{kind:'wallet',action,frozen:!current.wallet.frozen,expectedBalance:current.wallet.balance,expectedFrozen:current.wallet.frozen}:{kind:'labor',action,id:button.dataset.id};
    const feedback=button.closest('.card').querySelector('.finance-feedback')||view.querySelector('.finance-feedback');void send(input,feedback);
  });
}
