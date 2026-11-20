const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Hong_Kong',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

export function renderGroupPeople(people=[]){
  return `<section class="card full group-people" aria-labelledby="group-people-title">
    <div class="group-people-heading"><h2 id="group-people-title">QQ 群友</h2><span>${people.length} 位已认识</span></div>
    <p class="group-people-intro">记住的是同一个人，改昵称也不会忘。备注姓名会成为她优先使用的称呼。</p>
    ${people.length?`<div class="group-people-list">${people.map((p,i)=>{
      const nameId=`group-person-${i}`,fieldId=`group-remark-${i}`,hintId=`group-hint-${i}`;
      const history=p.history.filter(name=>name!==p.nickname);
      return `<article class="group-person" data-group-person>
        <div class="group-person-heading"><h3 id="${nameId}" data-person-name>${esc(p.displayName)}</h3><time datetime="${esc(p.lastSeenAt)}">最近聊过 · ${esc(clock.format(new Date(p.lastSeenAt)))}</time></div>
        <p class="group-person-nickname">QQ 昵称：${esc(p.nickname||'平台未提供昵称')}</p>
        ${p.lastMessage?`<p class="group-person-message">${esc(p.lastMessage)}</p>`:''}
        <form class="group-remark-form" aria-labelledby="${nameId}" data-actor-id="${esc(p.actorId)}" data-expected-remark="${esc(p.remark)}" data-automatic-name="${esc(p.automaticName)}">
          <div class="group-remark-field"><label for="${fieldId}">备注姓名</label><input id="${fieldId}" name="remark" type="text" maxlength="40" value="${esc(p.remark)}" placeholder="输入你熟悉的名字" autocomplete="off" aria-describedby="${hintId}"></div>
          <div class="group-remark-actions"><button type="submit" class="primary">保存备注</button><button type="button" class="secondary" data-clear-remark ${p.remark?'':'hidden'}>清除备注</button></div>
          <p class="group-remark-feedback" id="${hintId}" role="status"></p>
        </form>
        <details class="group-person-detail"><summary>身份编号 · ${esc(p.actorId.slice(-12))}${history.length?' / 曾用称呼':''}</summary>
          <p>固定身份：<code>${esc(p.actorId)}</code></p>${history.length?`<p>曾用称呼：${history.map(esc).join('、')}</p>`:''}
        </details>
      </article>`;
    }).join('')}</div>`:'<div class="empty">她还没有认识群友。绑定群中有人发言后，会显示在这里。</div>'}
    <p class="group-people-note">昵称随收到的 QQ 消息自动更新；平台未提供时，可直接填写备注。同名账号分别记录。</p>
  </section>`;
}

export function installGroupPeople(view,{api,version,onSaved}){
  async function save(form,clear=false){
    if(form.dataset.saving==='true'||view.hasAttribute('data-stale'))return;
    const input=form.elements.remark,feedback=form.querySelector('[role="status"]');
    if(!clear&&!input.reportValidity())return;
    const remark=clear?'':input.value.trim();
    if(remark.length>40||/[\x00-\x1f\x7f<>\u2028\u2029]/u.test(remark)){feedback.textContent='请填写 40 字以内的姓名，不含换行或尖括号。';feedback.dataset.error='true';return;}
    const controls=[...form.querySelectorAll('input,button')];
    form.dataset.saving='true';controls.forEach(c=>{c.disabled=true});feedback.textContent='正在保存…';delete feedback.dataset.error;
    try{
      await api().manage({kind:'group-remark',actorId:form.dataset.actorId,remark,expectedRemark:form.dataset.expectedRemark,version:version(),reason:remark?'爸爸设置群友备注姓名':'爸爸清除群友备注姓名'});
      form.dataset.expectedRemark=remark;input.value=remark;
      form.closest('[data-group-person]').querySelector('[data-person-name]').textContent=remark||form.dataset.automaticName;
      form.querySelector('[data-clear-remark]').hidden=!remark;
      feedback.textContent=remark?'已保存，她会优先这样称呼。':'备注已清除，继续使用已知称呼。';
      onSaved();
    }catch(error){feedback.textContent=error.message||'备注未保存，请重试。';feedback.dataset.error='true';}
    finally{delete form.dataset.saving;controls.forEach(c=>{c.disabled=false});if(form.isConnected)input.focus({preventScroll:true});}
  }
  view.addEventListener('submit',event=>{if(!event.target.matches('.group-remark-form'))return;event.preventDefault();void save(event.target)});
  view.addEventListener('click',event=>{const clear=event.target.closest('[data-clear-remark]');if(clear)void save(clear.closest('form'),true)});
}
