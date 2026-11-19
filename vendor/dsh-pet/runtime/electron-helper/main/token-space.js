'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

// Electron only sees Space keydown after the pet window has focus. Read the
// physical Space key through the bundled Windows runtime while dragging.
const SPACE_READER = [
  'import ctypes, sys',
  'is_down = ctypes.windll.user32.GetAsyncKeyState',
  'is_down.restype = ctypes.c_short',
  'for _ in sys.stdin.buffer:',
  '    print(int(bool(is_down(0x20) & 0x8000)), flush=True)',
].join('\n');

function registerTokenSpace({ app, ipcMain, petWindows }) {
  if (process.platform !== 'win32' || !process.env.PYTHONHOME) return;
  const worker = spawn(join(process.env.PYTHONHOME, 'python.exe'), ['-I', '-c', SPACE_READER], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: worker.stdout });
  let watched, pending, timer, closed = false;

  function poll() {
    if (closed || !watched || pending || watched.sender.isDestroyed()) return;
    pending = watched;
    worker.stdin.write('\n');
  }

  lines.on('line', line => {
    const request = pending;
    pending = undefined;
    if (closed || !watched || watched.sender.isDestroyed()) return;
    const pressed = line === '1';
    if (request === watched && pressed !== watched.pressed) {
      watched.pressed = pressed;
      watched.sender.send('pet:token-space', watched.id, pressed);
    }
    timer = setTimeout(poll, 16);
  });

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (watched && !watched.sender.isDestroyed()) watched.sender.send('pet:token-space', watched.id, undefined);
    watched = pending = undefined;
    lines.close();
    worker.stdin.end();
  };
  worker.on('error', close);
  worker.stdin.on('error', close);
  worker.on('exit', close);
  app.once('before-quit', close);

  ipcMain.on('pet:watch-token-space', (event, id, enabled) => {
    if (closed || !Number.isSafeInteger(id) || typeof enabled !== 'boolean') return;
    if (!enabled) {
      if (watched?.sender !== event.sender || watched.id !== id) return;
      watched = undefined;
      clearTimeout(timer);
      return;
    }
    const win = [...petWindows.state.windows.values()].find(win => win.webContents === event.sender);
    if (!win || !petWindows.state.inputBusy.get(win.id)) return;
    watched = { id, sender: event.sender };
    clearTimeout(timer);
    poll();
  });
}

module.exports = { registerTokenSpace };
