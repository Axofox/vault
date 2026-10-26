/**
 * IPC handler registration tests
 *
 * Guards against the "second recording/overlay attempt silently fails" bug.
 * Root cause: ipcMain.handleOnce registers a one-time handler; calling it a
 * second time without removing the first throws (or silently drops the call
 * in some Electron versions), leaving the Promise from openOverlay /
 * startRecording hanging forever.
 *
 * Fix: always call ipcMain.removeHandler(channel) before handleOnce.
 * These tests verify that contract without launching a real Electron process.
 */

'use strict';

// ── Minimal ipcMain mock ─────────────────────────────────────────────────────
function makeMockIpcMain() {
  const handlers = {};

  return {
    _handlers: handlers,

    handleOnce(channel, fn) {
      if (handlers[channel]) {
        throw new Error(
          `ipcMain.handleOnce: handler for '${channel}' already registered. ` +
          `Call ipcMain.removeHandler('${channel}') first.`
        );
      }
      handlers[channel] = fn;
    },

    removeHandler(channel) {
      delete handlers[channel];
    },

    // Helper: simulate the renderer sending an invoke
    async trigger(channel, ...args) {
      const fn = handlers[channel];
      if (!fn) throw new Error(`No handler registered for '${channel}'`);
      const result = await fn({}, ...args);
      delete handlers[channel]; // handleOnce fires once then clears
      return result;
    },
  };
}

// ── Helpers that mirror the real main.js logic ────────────────────────────────

function registerOverlayHandlers(ipcMain, resolve) {
  ipcMain.removeHandler('area-selected');
  ipcMain.removeHandler('area-cancel');

  ipcMain.handleOnce('area-selected', (_, b) => {
    const bounds = { x: b.x, y: b.y, width: b.w, height: b.h };
    resolve({ ok: true, bounds });
  });
  ipcMain.handleOnce('area-cancel', () => {
    resolve({ ok: false });
  });
}

function registerRecordingHandlers(ipcMain, sourceId, onSave) {
  ipcMain.removeHandler('get-source-id');
  ipcMain.removeHandler('save-recording');

  ipcMain.handleOnce('get-source-id', () => sourceId);
  ipcMain.handleOnce('save-recording', (_, bytes, ext) => onSave(bytes, ext));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('overlay IPC handlers', () => {
  test('registering handlers once does not throw', () => {
    const ipc = makeMockIpcMain();
    expect(() => registerOverlayHandlers(ipc, () => {})).not.toThrow();
  });

  test('registering handlers a second time does not throw (removeHandler called first)', () => {
    const ipc = makeMockIpcMain();
    registerOverlayHandlers(ipc, () => {});
    // Simulate: first overlay was cancelled without triggering the handler,
    // so the handler is still registered when a second overlay opens.
    expect(() => registerOverlayHandlers(ipc, () => {})).not.toThrow();
  });

  test('area-selected normalises {x,y,w,h} → {x,y,width,height}', async () => {
    const ipc = makeMockIpcMain();
    let resolved;
    registerOverlayHandlers(ipc, r => { resolved = r; });

    await ipc.trigger('area-selected', { x: 100, y: 200, w: 400, h: 300 });

    expect(resolved).toEqual({
      ok: true,
      bounds: { x: 100, y: 200, width: 400, height: 300 },
    });
  });

  test('area-selected resolves ok:true with correct bounds', async () => {
    const ipc = makeMockIpcMain();
    let resolved;
    registerOverlayHandlers(ipc, r => { resolved = r; });

    await ipc.trigger('area-selected', { x: 10, y: 20, w: 640, h: 480 });
    expect(resolved.ok).toBe(true);
    expect(resolved.bounds.width).toBe(640);
    expect(resolved.bounds.height).toBe(480);
  });

  test('area-cancel resolves ok:false', async () => {
    const ipc = makeMockIpcMain();
    let resolved;
    registerOverlayHandlers(ipc, r => { resolved = r; });

    await ipc.trigger('area-cancel');
    expect(resolved).toEqual({ ok: false });
  });

  test('two complete overlay sessions both resolve correctly', async () => {
    const ipc = makeMockIpcMain();
    const results = [];

    // First session
    registerOverlayHandlers(ipc, r => results.push(r));
    await ipc.trigger('area-selected', { x: 0, y: 0, w: 100, h: 100 });

    // Second session — this is the bug scenario
    registerOverlayHandlers(ipc, r => results.push(r));
    await ipc.trigger('area-selected', { x: 50, y: 50, w: 200, h: 150 });

    expect(results).toHaveLength(2);
    expect(results[0].bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(results[1].bounds).toEqual({ x: 50, y: 50, width: 200, height: 150 });
  });
});

describe('recording IPC handlers', () => {
  test('registering handlers once does not throw', () => {
    const ipc = makeMockIpcMain();
    expect(() => registerRecordingHandlers(ipc, 'src-1', () => {})).not.toThrow();
  });

  test('registering handlers a second time does not throw (removeHandler called first)', () => {
    const ipc = makeMockIpcMain();
    registerRecordingHandlers(ipc, 'src-1', () => {});
    // Handler still registered (recording never started/finished) — simulates the bug
    expect(() => registerRecordingHandlers(ipc, 'src-2', () => {})).not.toThrow();
  });

  test('get-source-id returns the correct sourceId', async () => {
    const ipc = makeMockIpcMain();
    registerRecordingHandlers(ipc, 'screen:0:0', () => {});

    const id = await ipc.trigger('get-source-id');
    expect(id).toBe('screen:0:0');
  });

  test('save-recording calls onSave with bytes and extension', async () => {
    const ipc = makeMockIpcMain();
    const saved = [];
    registerRecordingHandlers(ipc, 'src', (bytes, ext) => saved.push({ bytes, ext }));

    await ipc.trigger('save-recording', new Uint8Array([1, 2, 3]), 'webm');
    expect(saved).toHaveLength(1);
    expect(saved[0].ext).toBe('webm');
  });

  test('two complete recording sessions both save correctly', async () => {
    const ipc = makeMockIpcMain();
    const saves = [];

    // First recording
    registerRecordingHandlers(ipc, 'src-A', (b, e) => saves.push(e));
    await ipc.trigger('get-source-id');
    await ipc.trigger('save-recording', new Uint8Array([0]), 'webm');

    // Second recording — bug scenario
    registerRecordingHandlers(ipc, 'src-B', (b, e) => saves.push(e));
    await ipc.trigger('get-source-id');
    await ipc.trigger('save-recording', new Uint8Array([0]), 'webm');

    expect(saves).toHaveLength(2);
  });
});

describe('start-area-select return value', () => {
  // Simulates the full flow: openOverlay resolves, start-area-select unwraps it.
  // The renderer receives either {x,y,width,height} or null — never the {ok,bounds} wrapper.

  function simulateStartAreaSelect(ipc, overlayResult) {
    return new Promise(resolve =>
      // mirrors: ipcMain.handle('start-area-select', () => new Promise(resolve => openOverlay(r => resolve(r.ok ? r.bounds : null))))
      setTimeout(() => {
        const r = overlayResult;
        resolve(r.ok ? r.bounds : null);
      }, 0)
    );
  }

  test('resolves to the bounds object directly on selection', async () => {
    const bounds = { x: 100, y: 200, width: 400, height: 300 };
    const result = await simulateStartAreaSelect(null, { ok: true, bounds });
    expect(result).toEqual({ x: 100, y: 200, width: 400, height: 300 });
    // not wrapped — result.x exists directly
    expect(result.x).toBe(100);
    expect(result.width).toBe(400);
  });

  test('resolves to null on cancel (so renderer if(bounds) check works)', async () => {
    const result = await simulateStartAreaSelect(null, { ok: false });
    expect(result).toBeNull();
  });

  test('renderer if(bounds) is falsy on cancel', async () => {
    const result = await simulateStartAreaSelect(null, { ok: false });
    expect(result ? 'would start recording' : 'correctly skipped').toBe('correctly skipped');
  });
});

describe('recording frame receives valid window coordinates', () => {
  // Guards the bug where openRecordingFrame got {ok, bounds} instead of {x,y,width,height},
  // making Math.round(bounds.x) = NaN and Electron defaulting to the same position every time.

  function boundsFromOverlayDrag(drag) {
    // mirrors overlay.html: mouseup sends {x,y,w,h}
    const b = {
      x: Math.min(drag.startX, drag.endX),
      y: Math.min(drag.startY, drag.endY),
      w: Math.abs(drag.endX - drag.startX),
      h: Math.abs(drag.endY - drag.startY),
    };
    // mirrors openOverlay area-selected handler: normalise to {x,y,width,height}
    return { x: b.x, y: b.y, width: b.w, height: b.h };
  }

  function windowArgsFromBounds(bounds) {
    // mirrors openRecordingFrame
    const STOP_H = 40, PAD = 3;
    return {
      x:      Math.round(bounds.x) - PAD,
      y:      Math.round(bounds.y) - STOP_H - PAD,
      width:  Math.round(bounds.width)  + PAD * 2,
      height: Math.round(bounds.height) + STOP_H + PAD * 2,
    };
  }

  test('all window coordinates are finite numbers, not NaN', () => {
    const drag = { startX: 120, startY: 80, endX: 720, endY: 530 };
    const bounds = boundsFromOverlayDrag(drag);
    const win = windowArgsFromBounds(bounds);

    expect(Number.isFinite(win.x)).toBe(true);
    expect(Number.isFinite(win.y)).toBe(true);
    expect(Number.isFinite(win.width)).toBe(true);
    expect(Number.isFinite(win.height)).toBe(true);
  });

  test('frame position matches the drag area', () => {
    const drag = { startX: 120, startY: 80, endX: 720, endY: 530 };
    const bounds = boundsFromOverlayDrag(drag);
    const win = windowArgsFromBounds(bounds);
    const PAD = 3, STOP_H = 40;

    expect(win.x).toBe(drag.startX - PAD);
    expect(win.width).toBe(600 + PAD * 2);   // 720 - 120 = 600
    expect(win.height).toBe(450 + STOP_H + PAD * 2); // 530 - 80 = 450
  });

  test('different drag areas produce different frame positions', () => {
    const dragA = { startX: 50,  startY: 50,  endX: 400, endY: 300 };
    const dragB = { startX: 200, startY: 150, endX: 900, endY: 700 };

    const winA = windowArgsFromBounds(boundsFromOverlayDrag(dragA));
    const winB = windowArgsFromBounds(boundsFromOverlayDrag(dragB));

    expect(winA.x).not.toBe(winB.x);
    expect(winA.y).not.toBe(winB.y);
    expect(winA.width).not.toBe(winB.width);
    expect(winA.height).not.toBe(winB.height);
  });

  test('passing the old wrapped shape {ok,bounds} would have produced NaN (documents the original bug)', () => {
    const wrappedBounds = { ok: true, bounds: { x: 100, y: 200, width: 400, height: 300 } };
    // This is what main used to pass to openRecordingFrame before the fix
    const win = windowArgsFromBounds(wrappedBounds);

    expect(Number.isNaN(win.x)).toBe(true);
    expect(Number.isNaN(win.y)).toBe(true);
    expect(Number.isNaN(win.width)).toBe(true);
    expect(Number.isNaN(win.height)).toBe(true);
  });
});
