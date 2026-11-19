'use strict';

const path = require('node:path');
const { topmostLevel } = require('../topmost-watchdog.js');

const clamp = (value, low, high) => Math.round(Math.max(low, Math.min(high, value)));
const validRect = rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
  && rect.width > 0 && rect.height > 0;

function register({ ipcMain, BrowserWindow, screen, petWindows, hostRequest, dpi }) {
  const cookers = new Map();
  const owners = new Map();
  const getPointer = () => dpi.currentPointer();
  const entryFrom = event => event.senderFrame === event.sender.mainFrame && cookers.get(event.sender.id);
  const workArea = point => screen.getDisplayNearestPoint({
    x: Math.round(point.x), y: Math.round(point.y),
  }).workArea;

  function updatePointer(entry) {
    const { win, regions, drag } = entry;
    if (!win.isVisible()) return;
    const { x, y } = win.getContentBounds();
    const point = getPointer();
    const inside = regions.some(rect => point.x >= x + rect.x && point.x < x + rect.x + rect.width
      && point.y >= y + rect.y && point.y < y + rect.y + rect.height);
    const ignore = !drag && !inside;
    if (ignore !== entry.ignore) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
      entry.ignore = ignore;
    }
  }

  function place(entry) {
    if (!entry.layout) return false;
    const { win, anchor, layout, scale } = entry;
    const { art, launcher, panel } = layout;
    const area = workArea(entry.drag?.pointer ?? anchor);
    const right = area.x + area.width, bottom = area.y + area.height;
    const width = Math.min(area.width, Math.ceil(layout.width * scale));
    const height = Math.min(area.height, Math.ceil(layout.height * scale));
    const artCenter = (art.x + art.width / 2) * scale;
    const artBottom = (art.y + art.height) * scale;
    // The art keeps its own position while the panel and lid change height.
    const halfArt = art.width * scale / 2;
    const captionSpace = (launcher.y + launcher.height - art.y - art.height) * scale;
    anchor.x = clamp(anchor.x, area.x + halfArt, right - halfArt);
    anchor.y = clamp(anchor.y, area.y + art.height * scale, bottom - captionSpace);
    if (panel) {
      const panelSpace = (layout.height - launcher.height) * scale;
      const above = anchor.y - art.height * scale - area.y;
      const below = bottom - anchor.y - captionSpace;
      const panelBelow = above < panelSpace && below > above;
      if (panelBelow !== layout.panelBelow) {
        win.webContents.send('cooker:panel-side', panelBelow);
        return false;
      }
    }
    const x = clamp(anchor.x - artCenter, area.x, right - width);
    const y = clamp(anchor.y - artBottom, area.y, bottom - height);
    const key = [x, y, width, height].join(',');
    if (entry.boundsKey !== key) {
      entry.boundsKey = key;
      win.setContentBounds({ x, y, width, height });
    }
    entry.regions = [layout.grip, layout.caption, panel].filter(Boolean).map(rect => ({
      x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale,
    }));
    if (!win.isVisible()) {
      win.setAlwaysOnTop(true, topmostLevel(process.platform));
      win.showInactive();
    }
    updatePointer(entry);
    return true;
  }

  function notifyOwner(entry) {
    const { owner, win, layout, state, scale } = entry;
    if (!state || owner.isDestroyed() || !owner.isVisible()) return;
    let visit;
    if (state.batch && layout && win.isVisible() && !entry.drag) {
      const bounds = win.getContentBounds();
      const { grip } = layout;
      const x = bounds.x + grip.x * scale, y = bounds.y + grip.y * scale;
      const width = grip.width * scale, height = grip.height * scale;
      visit = { id: state.batch.id, x, y, width, height, area: workArea({ x: x + width / 2, y: y + height }) };
    }
    if (visit || state.replies?.length) owner.webContents.send('pet:cooker-update', { visit, reply: state.replies?.[0] });
  }

  ipcMain.on('pet:cooker-attach', (event, pose) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const petId = [...petWindows.state.windows].find(([, win]) => win === owner)?.[0];
    if (!petId || !pose || ![pose.x, pose.y, pose.size].every(Number.isFinite) || pose.size <= 0) return;
    if (owners.has(owner.id)) return;
    const scale = owner.webContents.getZoomFactor();
    const area = workArea(pose);
    const size = Math.min(pose.size, (Math.min(area.width, area.height) - 72 * scale) / scale);
    if (size <= 0) return;
    const anchor = { x: pose.x + (pose.x + size * scale <= area.x + area.width ? 1 : -1) * size * scale, y: pose.y };
    const win = new BrowserWindow({
      width: 1, height: 1, show: false, frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'rice-cooker-preload.js'),
        sandbox: true, backgroundThrottling: false, zoomFactor: scale,
      },
    });
    const entry = { owner, petId, win, anchor, scale, regions: [], ignore: true };
    cookers.set(win.webContents.id, entry);
    owners.set(owner.id, entry);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('show', () => petWindows.keepOffTaskbar(win));
    const pointerTimer = setInterval(() => updatePointer(entry), 16);
    const ownerClosed = () => win.destroy();
    owner.once('closed', ownerClosed);
    const displayChanged = () => { if (win.isVisible()) place(entry); };
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, displayChanged);
    const webId = win.webContents.id, ownerId = owner.id;
    win.on('closed', () => {
      clearInterval(pointerTimer);
      for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.off(name, displayChanged);
      owner.off('closed', ownerClosed);
      cookers.delete(webId);
      owners.delete(ownerId);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.loadFile(path.join(__dirname, '..', 'rice-cooker.html'), { query: { size: String(size) } })
      .then(() => {
        if (win.isDestroyed()) return;
        entry.loaded = true;
        if (entry.openRequested) win.webContents.send('cooker:open');
      })
      .catch(error => {
        console.error('[dsh-pet] 电饭锅窗口加载失败:', error.message);
        if (!win.isDestroyed()) win.destroy();
      });
  });

  ipcMain.on('pet:cooker-open', event => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const entry = owner && owners.get(owner.id);
    if (!entry) return;
    if (entry.loaded) entry.win.webContents.send('cooker:open');
    else entry.openRequested = true;
  });

  ipcMain.on('cooker:layout', (event, layout) => {
    const entry = entryFrom(event);
    if (!entry || !layout) return;
    if (!layout.visible) {
      entry.drag = null;
      entry.win.hide();
      return;
    }
    if (![layout.width, layout.height].every(value => Number.isFinite(value) && value > 0)
      || ![layout.art, layout.launcher, layout.grip, layout.caption].every(validRect)
      || (layout.panel && !validRect(layout.panel))) return;
    entry.layout = layout;
    if (place(entry)) notifyOwner(entry);
  });
  ipcMain.on('cooker:pointer', event => {
    const entry = entryFrom(event);
    if (entry) updatePointer(entry);
  });
  ipcMain.on('cooker:focus', event => {
    const entry = entryFrom(event);
    if (entry?.win.isVisible() && !entry.win.isFocused()) entry.win.focus();
  });
  ipcMain.on('cooker:drag', (event, { phase, x, y } = {}) => {
    const entry = entryFrom(event);
    if (!entry || !entry.win.isVisible() || ![x, y].every(Number.isFinite)) return;
    if (phase === 'start') {
      entry.drag = { x, y, anchor: { ...entry.anchor }, pointer: { x, y } };
    } else if (phase === 'end') {
      entry.drag = null;
    } else if (phase === 'move' && entry.drag) {
      const drag = entry.drag;
      drag.pointer = { x, y };
      entry.anchor = { x: drag.anchor.x + x - drag.x, y: drag.anchor.y + y - drag.y };
      place(entry);
    }
    updatePointer(entry);
  });

  ipcMain.handle('pet:rice-cooker', async (event, input) => {
    const entry = entryFrom(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const fromOwner = owner && owners.get(owner.id);
    const action = input?.action;
    const source = action === 'ack' && event.senderFrame === event.sender.mainFrame && owner?.isVisible()
      ? fromOwner : entry;
    if (!source || !(source === fromOwner ? action === 'ack' : ['snapshot', 'remind', 'take'].includes(action))) {
      throw Error('电饭锅窗口不可用');
    }
    const { requestId, expectedIds, bowls } = input;
    const response = await hostRequest('POST', '/__silicon/cooker', JSON.stringify({
      petId: source.petId, action, requestId, expectedIds, bowls,
    }));
    if (![200, 409].includes(response.status)) throw Error('电饭锅暂未连接');
    const state = JSON.parse(response.body || '{}');
    if (entry && !entry.win.isDestroyed() && response.status === 200) {
      entry.state = state;
      notifyOwner(entry);
    }
    return state;
  });
}

module.exports = { register };
