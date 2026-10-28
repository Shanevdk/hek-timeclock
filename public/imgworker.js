// Shrinks a photo before it's uploaded (uploader.js asks). Runs as a Web
// Worker, so decoding and re-encoding a 12-megapixel picture never freezes the
// page that asked for it.
//
// In:  { id, file, maxEdge, quality, applied }
// Out: { id, blob, oriented } — or { id, skip } / { id, error }, in which case
//      the original goes up untouched.
//
// Phones often store a photo sideways and record which way is up in its EXIF
// data. Most browsers turn the picture upright while decoding it; a browser
// that doesn't is caught (see below) and the turn is applied here, so nothing
// ever uploads lying on its side.
'use strict';

// The EXIF orientation (1–8, 1 when there is none) and the stored pixel size
// of a JPEG, read from its first bytes.
function jpegInfo(view) {
  const out = { orientation: 1, width: 0, height: 0 };
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return out;
  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) break;
    const marker = view.getUint8(at + 1);
    const size = view.getUint16(at + 2);
    if (marker === 0xda || marker === 0xd9) break; // the image data itself
    if (marker === 0xe1 && at + 10 <= view.byteLength && view.getUint32(at + 4) === 0x45786966) {
      out.orientation = exifOrientation(view, at + 10) || 1;
    }
    // Start-of-frame markers carry the size (C4, C8 and CC are something else).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && at + 9 <= view.byteLength) {
      out.height = view.getUint16(at + 5);
      out.width = view.getUint16(at + 7);
    }
    at += 2 + size;
  }
  return out;
}

function exifOrientation(view, tiff) {
  if (tiff + 8 > view.byteLength) return 0;
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > view.byteLength) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > view.byteLength) return 0;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

// Draw so the picture comes out upright, for an EXIF orientation the decoder
// did not apply. w and h are the upright (canvas) size.
function turn(ctx, o, w, h) {
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break; // mirrored
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break; // upside down
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break; // mirrored, upside down
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break; // mirrored, on its side
    case 6: ctx.transform(0, 1, -1, 0, w, 0); break; // on its side (the usual phone portrait)
    case 7: ctx.transform(0, -1, -1, 0, w, h); break; // mirrored, on its other side
    case 8: ctx.transform(0, -1, 1, 0, 0, h); break; // on its other side
    default: break;
  }
}

self.onmessage = async (e) => {
  const { id, file, maxEdge, quality, applied } = e.data;
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function')
      return self.postMessage({ id, skip: 'unsupported' });
    const info = jpegInfo(new DataView(await file.slice(0, 256 * 1024).arrayBuffer()));
    const bmp = await createImageBitmap(file);
    const o = info.orientation;
    // Did decoding already turn it upright? A sideways photo (5–8) answers
    // that itself: upright, its width and height come out swapped. A mirrored
    // or upside-down one (2–4) looks the same either way, so it goes by what
    // an earlier sideways photo showed about this browser — and when nothing
    // has shown it yet, it is left alone rather than risk it.
    let oriented = true;
    if (o >= 5) {
      if (!info.width || info.width === info.height) {
        bmp.close();
        return self.postMessage({ id, skip: 'orientation' });
      }
      oriented = bmp.width === info.height && bmp.height === info.width;
    } else if (o > 1) {
      if (applied !== true && applied !== false) {
        bmp.close();
        return self.postMessage({ id, skip: 'orientation' });
      }
      oriented = applied;
    }
    const fix = oriented ? 1 : o;
    const sideways = fix >= 5;
    const W = sideways ? bmp.height : bmp.width;
    const H = sideways ? bmp.width : bmp.height;
    const scale = Math.min(1, maxEdge / Math.max(W, H));
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    turn(ctx, fix, w, h);
    ctx.drawImage(bmp, 0, 0, sideways ? h : w, sideways ? w : h);
    bmp.close();
    // WebP where the browser can write it; Safari hands back a PNG when asked
    // for a type it can't make, so that is checked, and JPEG used instead.
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    self.postMessage({ id, blob, oriented: o >= 5 ? oriented : undefined });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
