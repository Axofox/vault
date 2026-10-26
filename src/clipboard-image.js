const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Screenshot shortcuts that copy to the clipboard (e.g. Cmd+M) never create a file,
// so save clipboard images into the vault ourselves.
function createClipboardImageCapture({ clipboard, dir, onSaved }) {
  let lastHash = '';

  const hash = img => crypto.createHash('md5').update(img.toBitmap()).digest('hex');

  return {
    // Call after the app itself writes an image to the clipboard, so it isn't re-captured.
    markSeen(img) { lastHash = hash(img); },

    capture() {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      const h = hash(img);
      if (h === lastHash) return null;
      lastHash = h;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `clip-${Date.now()}.png`);
      fs.writeFileSync(file, img.toPNG());
      onSaved(file);
      return file;
    },
  };
}

module.exports = { createClipboardImageCapture };
