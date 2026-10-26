/**
 * Clipboard image capture tests
 *
 * Cmd+M (macOS "copy selected area to clipboard") creates no file, so the app
 * saves clipboard images itself. These tests cover that module with a fake
 * clipboard, no Electron needed.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClipboardImageCapture } = require('../src/clipboard-image');

function fakeImage(bytes) {
  return {
    isEmpty: () => bytes.length === 0,
    toBitmap: () => Buffer.from(bytes),
    toPNG: () => Buffer.from('png:' + bytes.join(',')),
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-clip-'));
  const state = { image: fakeImage([]) };
  const saved = [];
  const clipboard = { readImage: () => state.image };
  const capture = createClipboardImageCapture({
    clipboard, dir: path.join(dir, 'screenshots'), onSaved: f => saved.push(f),
  });
  return { dir, state, saved, capture };
}

describe('clipboard image capture', () => {
  test('ignores an empty clipboard', () => {
    const { capture, saved } = setup();
    expect(capture.capture()).toBeNull();
    expect(saved).toEqual([]);
  });

  test('saves a new clipboard image as a PNG and reports the file', () => {
    const { capture, state, saved } = setup();
    state.image = fakeImage([1, 2, 3]);
    const file = capture.capture();
    expect(file).toMatch(/clip-\d+\.png$/);
    expect(fs.readFileSync(file).toString()).toBe('png:1,2,3');
    expect(saved).toEqual([file]);
  });

  test('does not save the same image twice while it stays on the clipboard', () => {
    const { capture, state, saved } = setup();
    state.image = fakeImage([1, 2, 3]);
    capture.capture();
    expect(capture.capture()).toBeNull();
    expect(saved).toHaveLength(1);
  });

  test('saves again when a different image is copied', () => {
    const { capture, state, saved } = setup();
    state.image = fakeImage([1, 2, 3]);
    capture.capture();
    state.image = fakeImage([4, 5, 6]);
    expect(capture.capture()).not.toBeNull();
    expect(saved).toHaveLength(2);
  });

  test('markSeen stops the app re-capturing an image it copied itself', () => {
    const { capture, state, saved } = setup();
    const img = fakeImage([7, 8, 9]);
    capture.markSeen(img);
    state.image = img;
    expect(capture.capture()).toBeNull();
    expect(saved).toEqual([]);
  });
});
