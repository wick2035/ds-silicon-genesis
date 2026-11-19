'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: wait } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'vendor/dsh-pet/runtime/electron-helper');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'silicon-tokens-smoke-'));
const page = path.join(profile, 'test.html');
fs.writeFileSync(page, '<!doctype html><meta charset="utf-8">');
app.setPath('userData', profile);
const deadline = setTimeout(() => { console.error('Token smoke test timed out'); app.exit(1); }, 12000);

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await wait(20);
  }
  throw Error('Token state did not settle');
}

app.whenReady().then(async () => {
  const load = file => import(pathToFileURL(path.join(root, file)).href);
  const { CompanionStore } = await load('vendor/pet-plugins/behavior/core.mjs');
  const { LegacyDomain } = await load('dist/host/legacy-domain.js');
  const { createHelperTokens } = await load('dist/host/helper-tokens.js');
  const old = Object.assign(Object.create(CompanionStore.prototype), {
    data: { version: 2, pets: {} }, loaded: true, clock: Date.now, save() {}, load() {},
  });
  let state = { petId: 'main', version: 0, legacy: old.read('main'), life: { events: [], memories: [], invalidSources: {} } };
  const store = { loadEnvelope: async () => structuredClone(state) };
  const gate = { signal: new AbortController().signal, run: async (_id, fn) => fn() };
  const uow = { apply: async (_id, version, change) => {
    assert.equal(version, state.version);
    const draft = structuredClone(state);
    change(draft);
    draft.version++;
    state = draft;
  } };
  const authority = {};
  const tokens = createHelperTokens(store, new LegacyDomain(store, uow, gate, authority), authority);
  const actions = [];
  let watch;
  ipcMain.on('pet:watch-token-space', (event, id, enabled) => {
    watch = enabled ? { sender: event.sender, id } : undefined;
  });
  ipcMain.handle('pet:interaction', (_event, { kind, detail }) => {
    assert.equal(kind, 'tokens');
    actions.push(detail.action);
    return tokens.handle('main', 'smoke-token-' + actions.length, detail);
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(helper, 'preload.js'), backgroundThrottling: false },
  });
  await win.loadFile(page);
  const render = source => win.webContents.executeJavaScript(source);
  await render(`
    const BASE = '';
    const VIEW = { w: 1000, h: 800 }, WORK_AREAS = [{ x: 0, y: 0, width: 1000, height: 800 }], AREAS = WORK_AREAS;
    const S = { resolveRect: areas => areas[0] }, toLocal = value => value;
    window.fetch = async () => new Response(JSON.stringify({ ok: true, tokens: { coins: [], balance: 10000 } }));
    class PetSprite {
      pet = { id: 'main' };
      dragState = { active: false };
      pos = { x: 460, y: 240 };
      winOffset = { x: 0, y: 0 };
      halfW = 40;
      halfH = 40;
      height = 80;
      bindEvents() {}
      onPointerDown() { this.dragState = { active: true, sling: true }; }
      onPointerMove() {}
      onPointerUp() { this.dragState.active = false; }
      stopThrow() {}
      sendBounds() {}
    }
    void 0;
  `);
  for (const name of ['token-scene.js', 'desktop-tokens.js']) {
    await render(fs.readFileSync(path.join(helper, 'sprite', name), 'utf8'));
  }
  await render('const sprite = new PetSprite(); sprite.bindEvents()');
  assert.equal(await render('document.hasFocus()'), false);
  assert.equal(await render('sprite.tokenScene.space'), false);
  await render('sprite.onPointerDown({ button: 0, screenX: 400, screenY: 300 })');
  await until(() => watch);
  watch.sender.send('pet:token-space', watch.id, true);
  await until(() => tokens.held('main'));
  await render('sprite.onPointerMove({ screenX: 500, screenY: 300 })');
  await render('sprite.onPointerMove({ screenX: 400, screenY: 300 })');
  await until(() => state.legacy.wallet.balance === 9900);
  await until(() => render('document.querySelector(".pet-token-face")?.textContent === "100"'));
  watch.sender.send('pet:token-space', watch.id, false);
  await until(async () => await render('sprite.tokenScene.space') === false);
  await wait(300);
  await render('sprite.onPointerMove({ screenX: 500, screenY: 300 }); sprite.onPointerMove({ screenX: 400, screenY: 300 })');
  await render('sprite.pollTokenSoon = () => {}; sprite.onPointerUp()');
  await until(() => !watch && !tokens.held('main'));

  await render('sprite.onPointerDown({ button: 0, screenX: 400, screenY: 300 })');
  await until(() => watch);
  watch.sender.send('pet:token-space', watch.id, false);
  await render('sprite.onPointerMove({ screenX: 500, screenY: 300 }); sprite.onPointerMove({ screenX: 400, screenY: 300 })');
  assert.equal(await render('sprite.dragState.sling'), true);
  await render('sprite.onPointerUp()');
  await until(() => !watch);
  assert.deepEqual(actions, ['hold', 'drop', 'release']);
  assert.equal(state.legacy.wallet.balance, 9900);
  win.destroy();
  clearTimeout(deadline);
  console.log('Unfocused Space drag dropped one 100-token coin and released the hold.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
