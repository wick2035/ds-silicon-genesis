'use strict';
(() => {
  const params = new URLSearchParams(location.search);
  const pet = params.get('pet') || 'main';
  const laborPage = params.get('view') === 'labor';
  if(laborPage){
    document.body.classList.add('labor-page');document.title='大肥鱼 · 搬砖';
    for(const b of document.querySelectorAll('[data-tab]')){const active=b.dataset.tab==='labor-book';b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));document.getElementById(b.dataset.tab).hidden=!active;}
    return;
  }
  if (params.get('compact') === '1') document.body.classList.add('compact');
  const base = location.pathname.replace(/\/humanity\/?$/, '');
  const $ = (id) => document.getElementById(id);
  let state, busy = false, pollTimer, activeRequest = null, memoryRevision;
  const pollDelay = () => state?.responses?.length ? 1000 : 5000;
  document.querySelector('.wordmark').href = location.pathname + '?pet=' + encodeURIComponent(pet);
  const nodes = {};
  const editorRows = {}, dirty = new Set();
  let editorRevision = 0, receipt;
  function resetEditor() {
    dirty.clear(); receipt = null; editorRevision = state?.adjustmentRevision || 0;
    for (const [key, row] of Object.entries(editorRows)) {
      row.range.value = row.number.value = String(Math.round(state.stats[key]));
      row.current.textContent = '当前 ' + Math.round(state.stats[key]);
      row.el.classList.remove('is-edited');
    }
    $('state-apply').disabled = busy || !dirty.size;
  }
  function makeEditor(s) {
    for (const [key, title] of Object.entries(s.labels.stats)) {
      const el = document.createElement('div'); el.className = 'state-field';
      const heading = document.createElement('div'); heading.className = 'state-field-heading';
      const label = document.createElement('label'); label.htmlFor = 'state-number-' + key; label.textContent = title;
      const current = document.createElement('span'); heading.append(label, current);
      const controls = document.createElement('div'); controls.className = 'state-field-controls';
      const range = document.createElement('input'), number = document.createElement('input');
      range.type = 'range'; number.type = 'number'; number.id = label.htmlFor; number.inputMode = 'numeric'; number.required = true;
      for (const input of [range, number]) { input.min = '0'; input.max = '100'; input.step = '1'; }
      range.setAttribute('aria-label', title + '滑杆');
      for (const input of [range, number]) input.addEventListener('input', () => {
        if (input.validity.valid && input.value !== '') (input === range ? number : range).value = input.value;
        dirty.add(key); receipt = null; el.classList.add('is-edited'); $('state-apply').disabled = busy;
        $('state-feedback').textContent = '已修改 ' + dirty.size + ' 项，点击“立即生效”后改变。'; $('state-feedback').classList.remove('error');
      });
      controls.append(range, number); el.append(heading, controls); $('state-inputs').append(el);
      editorRows[key] = { el, range, number, current };
    }
    resetEditor(); $('state-fields').disabled = false; $('state-reset').disabled = false;
  }
  function setBusy(value) {
    busy = value;
    for (const b of $('actions').querySelectorAll('button')) b.disabled = value;
    $('state-fields').disabled = value; $('state-reset').disabled = value; $('state-apply').disabled = value || !dirty.size;
  }
  function makeMetrics(values, labels, parent, kind) {
    for (const key of Object.keys(values)) {
      const el = document.createElement('div'); el.className = kind;
      const label = document.createElement('span'); label.textContent = labels[key];
      const value = document.createElement('strong');
      const track = document.createElement('div'); track.className = 'track';
      const fill = document.createElement('div'); fill.className = 'fill'; track.append(fill);
      if (kind === 'metric') { const top = document.createElement('div'); top.className = 'metric-label'; value.className = 'metric-value'; top.append(label, value); el.append(top, track); }
      else if (kind === 'emotion') { label.className = 'emotion-name'; el.append(label, value); }
      else el.append(label, track, value);
      parent.append(el); nodes[kind + key] = { el, value, fill, track, label };
    }
  }
  function render(s, name) {
    if (state && s.updatedAt < state.updatedAt) return;
    if (!state) { makeMetrics(s.stats, s.labels.stats, $('stats'), 'metric'); makeMetrics(s.emotions, s.labels.emotions, $('emotions'), 'emotion'); makeMetrics(s.desires, s.labels.desires, $('desires'), 'desire'); }
    state = s;
    if (!Object.keys(editorRows).length) makeEditor(s);
    for (const [key, row] of Object.entries(editorRows)) row.current.textContent = '当前 ' + Math.round(s.stats[key]);
    if (!dirty.size) resetEditor();
    if (name) { $('pet-name').textContent = name; document.title = name + ' · 身心小记'; }
    $('mood').textContent = s.mood; $('thought').textContent = s.thought; $('suggestion').textContent = s.suggestion;
    for (const [kind, values] of [['metric', s.stats], ['emotion', s.emotions], ['desire', s.desires]]) {
      for (const [key, v] of Object.entries(values)) {
        const n = nodes[kind + key], num = Math.round(v); n.value.textContent = String(num); n.fill.style.width = num + '%';
        n.el.setAttribute('aria-label', n.label.textContent + ' ' + num + ' / 100');
        n.el.classList.toggle('dominant', kind === 'emotion' && s.labels.emotions[key] === s.dominant);
        n.el.classList.toggle('warning', kind === 'metric' && (['pain', 'stress'].includes(key) ? num > 35 : num < 30));
      }
    }
    document.querySelector('[data-action=rest]').hidden = s.resting;
    document.querySelector('[data-action=wake]').hidden = !s.resting;
    $('care-hint').textContent = s.resting ? '困了就让它慢慢歇一会儿' : '小事也会被记住';
    const revision = JSON.stringify(s.memories);
    if (revision !== memoryRevision) {
    memoryRevision = revision;
    const list = $('memory-list'); list.replaceChildren();
    if (!s.memories.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '还没有写下小事。轻轻摸摸头，今天就从这一刻开始。'; list.append(p); }
    for (const m of s.memories) { const li = document.createElement('li'), time = document.createElement('time'), text = document.createElement('span'); time.dateTime = new Date(m.ts).toISOString(); time.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(m.ts); text.textContent = m.text; li.append(time, text); list.append(li); }
    }
    $('updated').textContent = '刚刚听到它的心事 · ' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now());
  }
  async function request(path, body, signal) {
    const res = await fetch(base + '/humanity/' + path + '?pet=' + encodeURIComponent(pet), { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    let r; try { r = await res.json(); } catch { throw new Error('连接已断开，请打开大肥鱼后重试'); }
    if (!res.ok || !r.ok) { const e = new Error(r.message || '暂时连不上它，请稍后重试'); e.state = r.state; throw e; }
    return r;
  }
  async function refresh() {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    if (activeRequest) return;
    const requestController = new AbortController(); activeRequest = requestController;
    try { const r = await request('state', undefined, requestController.signal); render(r.state, r.name); $('connection').textContent = '它就在这里'; $('connection').classList.remove('error'); }
    catch (e) { if (e.name !== 'AbortError') { $('connection').textContent = '暂时没连上'; $('connection').classList.add('error'); $('feedback').textContent = e.message; $('feedback').classList.add('error'); } }
    finally { if (activeRequest === requestController) { activeRequest = null; pollTimer = setTimeout(refresh, busy ? 1000 : pollDelay()); } }
  }
  $('actions').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-action]'); if (!button || busy) return;
    setBusy(true); clearTimeout(pollTimer); activeRequest?.abort(); activeRequest = null; $('feedback').textContent = '轻轻陪它一下…'; $('feedback').classList.remove('error');
    const buttons = [...$('actions').querySelectorAll('button')]; buttons.forEach((b) => b.disabled = true);
    pollTimer = setTimeout(refresh, 1000);
    try { const r = await request('care', { action: button.dataset.action }); render(r.state); $('feedback').textContent = r.reaction?.ok === false ? '照料已完成，但她暂时无法回复：' + r.reaction.message : r.text; $('feedback').classList.toggle('error', r.reaction?.ok === false); }
    catch (e) { $('feedback').textContent = e.message; $('feedback').classList.add('error'); }
    finally { setBusy(false); clearTimeout(pollTimer); pollTimer = setTimeout(refresh, pollDelay()); }
  });
  $('state-reset').addEventListener('click', () => {
    resetEditor(); $('state-feedback').textContent = '已读取当前值，可以重新调整。'; $('state-feedback').classList.remove('error');
  });
  $('state-adjust').addEventListener('submit', async e => {
    e.preventDefault(); if (busy || !dirty.size) return;
    const stats = Object.fromEntries([...dirty].map(key => [key, Number(editorRows[key].number.value)]));
    receipt ||= { stats, requestId: crypto.randomUUID(), expectedRevision: editorRevision };
    setBusy(true); $('state-feedback').textContent = '正在改变状态…'; $('state-feedback').classList.remove('error');
    try {
      const r = await request('adjust', receipt); render(r.state); resetEditor();
      $('state-feedback').textContent = r.duplicate ? '这次干预已经生效，自动变化照常。' : !r.changed ? '当前状态已是这些数值，自动变化照常。' : '已立即生效，自动变化照常。' + (r.reaction?.queued ? '她的回应会出现在聊天里。' : r.reaction?.message || '');
    } catch (error) {
      if (error.state) render(error.state);
      $('state-feedback').textContent = error.message + '。可重试，或点击“读取当前值”重新调整。'; $('state-feedback').classList.add('error');
    } finally { setBusy(false); }
  });
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    if(button.dataset.tab==='labor-book'&&!laborPage){
      if(window.parent!==window)window.parent.postMessage({type:'dsh-pet-open-labor'},location.origin);
      else location.search='?pet='+encodeURIComponent(pet)+'&view=labor';
      return;
    }
    for (const b of document.querySelectorAll('[data-tab]')) { const active = b === button; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); $(b.dataset.tab).hidden = !active; }
  }));
  document.addEventListener('visibilitychange', () => { clearTimeout(pollTimer); if (!document.hidden) void refresh(); });
  window.addEventListener('pagehide', () => { clearTimeout(pollTimer); activeRequest?.abort(); });
  void refresh();
})();
