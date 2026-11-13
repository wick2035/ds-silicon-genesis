import { createPetChatState } from './state.ts';
import { buildPanel } from './view.ts';
import { LOGO_URL } from './api.ts';
import { ROUTE_PATH } from '../../shared/constants.ts';
import { injectPanelCss } from './styles.ts';
// Main-window companion view. Chat state, requests and history belong to dsh-pet.
export function registerPetCompanionPage(ctx, rt) {
  const { h, useState, useEffect } = rt;
  const useChatState = createPetChatState(rt);
  function CompanionPage() {
    const state = useChatState();
    const [view, setView] = useState('chat');
    const [careOpen, setCareOpen] = useState(true);
    const [careWidth, setCareWidth] = useState(340);
    const [drag, setDrag] = useState(null);
    useEffect(() => {
      const open = event => { if (event.origin !== window.location.origin) return; if(event.data?.type === 'dsh-pet-open-chat') setView('chat'); if(event.data?.type === 'dsh-pet-open-labor') setView('labor'); };
      window.addEventListener('message', open); return () => window.removeEventListener('message', open);
    }, []);
    const clampWidth = value => Math.max(260, Math.min(600, value, Math.max(260, window.innerWidth - 320)));
    const pet = state.pets.find(item => item.id === state.petId);
    const name = pet?.name || '大肥鱼';
    return h('section', {
      className: 'pet-companion-page', 'aria-label': '宠物陪伴',
      children: [
        h('header', { className: 'pet-companion-header', children: [
          h('div', { className: 'pet-companion-heading', children: [
            h('img', { src: LOGO_URL, alt: '', className: 'pet-companion-avatar' }),
            h('div', { children: [
              h('h1', { children: '宠物陪伴' }),
              h('p', { children: '和' + name + '聊聊天，把日常慢慢记下来。' }),
            ] }),
          ] }),
          h('nav', { className: 'pet-companion-views', 'aria-label': '陪伴方式', children: [
            h('button', { type: 'button', 'aria-pressed': view === 'chat', onClick: () => setView('chat'), children: '聊聊天' }),
            h('button', { type: 'button', 'aria-pressed': view === 'care', disabled: !state.petId, onClick: () => setView('care'), children: '身心小记' }),
            h('button', { type: 'button', 'aria-pressed': view === 'labor', disabled: !state.petId, onClick: () => setView('labor'), children: '搬砖' }),
          ] }),
        ] }),
        h('div', { className: 'pet-companion-workspace', hidden: view !== 'chat', children: [
          h('div', { className: 'pet-companion-conversation', children: buildPanel(rt, state) }),
          state.petId ? h('aside', { className: 'pet-care-rail' + (careOpen ? ' is-open' : ''), style: { '--care-width': careWidth + 'px' }, 'aria-label': name + '的身心小记', children: [
            h('div', { className: 'pet-care-resize', role: 'separator', tabIndex: 0, 'aria-label': '调整身心小记宽度', 'aria-orientation': 'vertical', 'aria-valuemin': 260, 'aria-valuemax': 600, 'aria-valuenow': careWidth, onPointerDown: e => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ x: e.clientX, width: careWidth }); }, onPointerMove: e => { if (drag) setCareWidth(clampWidth(drag.width + drag.x - e.clientX)); }, onPointerUp: () => setDrag(null), onPointerCancel: () => setDrag(null), onKeyDown: e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setCareWidth(clampWidth(careWidth + (e.key === 'ArrowLeft' ? 20 : -20))); } } }),
            h('div', { className: 'pet-care-rail-heading', children: [
              h('div', { children: [h('strong', { children: '身心小记' }), h('span', { children: '陪你聊天，也留意它的心情' })] }),
              h('button', { type: 'button', className: 'pet-care-close', onClick: () => setCareOpen(false), 'aria-label': '收起身心小记', children: '收起' }),
            ] }),
            careOpen && view === 'chat' ? h('iframe', { key: state.petId, title: name + '的身心小记', className: 'pet-care-frame', src: ROUTE_PATH + '/humanity?pet=' + encodeURIComponent(state.petId) + '&compact=1', sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads' }) : null,
          ] }) : null,
          state.petId && !careOpen ? h('button', { type: 'button', className: 'pet-care-open', onClick: () => setCareOpen(true), children: '身心小记' }) : null,
        ] }),
        view === 'care' && state.petId ? h('iframe', {
          key: state.petId, className: 'pet-companion-care', title: name + '的身心小记',
          src: ROUTE_PATH + '/humanity?pet=' + encodeURIComponent(state.petId),
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
        }) : null,
        view === 'labor' && state.petId ? h('iframe', {
          key: 'labor-' + state.petId, className: 'pet-companion-care', title: name + '的搬砖页面',
          src: ROUTE_PATH + '/humanity?pet=' + encodeURIComponent(state.petId) + '&view=labor',
          sandbox: 'allow-scripts allow-same-origin allow-forms',
        }) : null,
      ],
    });
  }
  function CompanionIcon({ size = 16 } = {}) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, children: [
      h('path', { d: 'M20.5 11.2a8.5 8.5 0 0 1-8.5 8.5H5l-3 2v-6.2a8.5 8.5 0 1 1 18.5-4.3Z' }),
      h('path', { d: 'M8 10.5h.01M12 10.5h.01M16 10.5h.01', strokeWidth: 2.8 }),
    ] });
  }
  const disposeChatCss = injectPanelCss();
  const style = document.createElement('style');
  style.dataset.dshPetCss = 'companion-page';
  style.textContent = COMPANION_PAGE_CSS;
  document.head.append(style);
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'pet-companion', order: 100 }, CompanionPage);
  });
  ctx.slots.inject('sidebar.panellist', function* () {
    yield ctx.slots.register({ name: 'sidebar.panellist', id: 'pet-companion', order: 25, label: '宠物陪伴' }, CompanionIcon);
  });
  return () => { style.remove(); disposeChatCss(); };
}

const COMPANION_PAGE_CSS = `
.pet-companion-page{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14)}
.pet-companion-page *{box-sizing:border-box}
.pet-companion-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:28px 36px 22px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-shrink:0}
.pet-companion-heading{display:flex;align-items:center;gap:14px;min-width:0}
.pet-companion-avatar{height:44px;width:44px;object-fit:contain;flex-shrink:0}
.pet-companion-heading h1{margin:0;font-size:21px;line-height:1.4;font-weight:600;letter-spacing:-.02em}
.pet-companion-heading p{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.pet-companion-views{display:flex;gap:4px;flex-shrink:0;padding:4px;background:var(--dsw-alias-bg-module-platform);border-radius:10px}
.pet-companion-views button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;min-height:34px;padding:7px 14px;border-radius:7px;cursor:pointer;transition:background 150ms ease-out,color 150ms ease-out}
.pet-companion-views button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pet-companion-views button[aria-pressed=true]{background:var(--dsw-alias-bg-multi-select);color:var(--dsw-alias-label-primary);font-weight:500}
.pet-companion-views button:disabled{opacity:.45;cursor:default}
.pet-companion-page button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}
.pet-companion-workspace{display:flex;position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}
.pet-companion-workspace[hidden]{display:none}
.pet-companion-conversation{flex:1;min-width:0;min-height:0;width:100%;max-width:960px;margin:0 auto;padding:20px 32px 24px}
.pet-care-rail{position:relative;display:none;flex:0 0 var(--care-width,340px);min-width:0;min-height:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.pet-care-rail.is-open{display:flex;flex-direction:column}
.pet-care-resize{position:absolute;z-index:5;left:-5px;top:0;bottom:0;width:10px;cursor:col-resize;touch-action:none}.pet-care-resize:hover,.pet-care-resize:focus-visible{background:var(--dsw-alias-bg-multi-select);outline:none}.pet-care-resize:active{background:var(--dsw-alias-interactive-bg-hover)}
.pet-care-rail-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 20px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pet-care-rail-heading strong,.pet-care-rail-heading span{display:block}.pet-care-rail-heading strong{font-size:15px;font-weight:600}.pet-care-rail-heading span{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:12px}
.pet-care-close,.pet-care-open{border:0;border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;padding:8px 10px}.pet-care-close:hover,.pet-care-open:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pet-care-open{align-self:flex-start;margin:18px 14px 0 0;white-space:nowrap}.pet-care-frame{width:100%;flex:1;min-height:0;border:0;background:var(--dsw-alias-bg-base);color-scheme:normal}
@media(max-width:820px){.pet-care-rail.is-open{position:absolute;z-index:4;right:0;top:0;bottom:0;width:min(var(--care-width,340px),100%);box-shadow:-8px 0 24px #17213224}.pet-care-open{position:absolute;z-index:3;right:0;top:0;margin:8px}}

.pet-companion-conversation[hidden]{display:none}
.pet-companion-conversation>.pet-chat{padding:0;gap:14px}
.pet-companion-conversation .pet-chat-list{padding:12px 4px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l3) transparent}
.pet-companion-conversation .pet-chat-hint{display:grid;place-content:center;min-height:180px;height:100%;font-size:15px;color:var(--dsw-alias-label-secondary)}
.pet-companion-conversation .pet-chat-composer{flex-shrink:0}
.pet-companion-conversation .pet-chat-input{caret-color:var(--dsw-alias-label-primary)}
.pet-companion-page ::selection{background:var(--dsw-alias-bg-multi-select);color:var(--dsw-alias-label-primary)}
.pet-companion-care{flex:1;width:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base);color-scheme:normal}
@media(max-width:680px){.pet-companion-header{padding:20px;align-items:flex-start;flex-direction:column;gap:16px}.pet-companion-heading h1{font-size:19px}.pet-companion-views{align-self:flex-start}.pet-companion-conversation{padding:16px 16px 18px}}
@media(prefers-reduced-motion:reduce){.pet-companion-views button{transition:none}}
`;
