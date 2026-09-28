// 加密分享: remove hidden metadata from photos before encryption (runs in the browser).
//
// JPEG: drops EXIF (GPS, camera, time, thumbnails), XMP, IPTC, comments and anything after the
//       main image (MPF second images such as depth maps carry their own EXIF). Keeps colour
//       profiles, and keeps the Orientation tag so photos are not shown sideways.
// PNG:  drops text chunks, eXIf and tIME.
// WebP: drops EXIF and XMP chunks.
// Other files are returned unchanged; the caller warns about them.

const u16 = (b, i, le) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
const u32 = (b, i, le) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
const startsWith = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function kindOf(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (startsWith(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp';
  return null;
}

// Orientation (1-8) from an EXIF APP1 payload starting with "Exif\0\0", or 1
function exifOrientation(b, start, end) {
  const t = start + 6;
  if (t + 8 > end) return 1;
  const le = b[t] === 0x49;
  const ifd = t + u32(b, t + 4, le);
  if (ifd + 2 > end) return 1;
  const n = u16(b, ifd, le);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (u16(b, e, le) === 0x0112) {
      const v = u16(b, e + 8, le);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

// A minimal EXIF segment holding only the Orientation tag
function orientationApp1(o) {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0, 0];
  const payload = [...'Exif\0\0'].map((c) => c.charCodeAt(0)).concat(tiff);
  const len = payload.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

export function stripJpeg(b) {
  const out = [b.subarray(0, 2)];
  let orientation = 1;
  let i = 2;
  let insertAt = 1; // after SOI, or after APP0 when present
  for (;;) {
    if (i + 2 > b.length || b[i] !== 0xff) throw new Error('jpeg');
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0xd9) {
      out.push(b.subarray(i, i + 2));
      break; // end of the main image: anything after it is dropped
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) throw new Error('jpeg');
    const len = u16(b, i + 2);
    const segEnd = i + 2 + len;
    if (len < 2 || segEnd > b.length) throw new Error('jpeg');
    const p = i + 4; // payload
    let keep = true;
    if (m === 0xe1) {
      if (startsWith(b, p, 'Exif\0\0')) orientation = exifOrientation(b, p, segEnd);
      keep = false; // EXIF, XMP
    } else if (m === 0xe0) {
      keep = startsWith(b, p, 'JFIF\0') || startsWith(b, p, 'JFXX\0');
    } else if (m === 0xe2) {
      keep = startsWith(b, p, 'ICC_PROFILE\0'); // drops MPF (index of extra images)
    } else if (m === 0xee) {
      keep = startsWith(b, p, 'Adobe'); // colour transform flag
    } else if ((m >= 0xe3 && m <= 0xef) || m === 0xfe) {
      keep = false; // other APPn (IPTC, maker data), comments
    }
    if (keep) {
      out.push(b.subarray(i, segEnd));
      if (m === 0xe0 && out.length === 2) insertAt = 2;
    }
    i = segEnd;
    if (m === 0xda) {
      // Entropy-coded data up to the next marker that is not a stuffed byte or restart marker
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) throw new Error('jpeg');
      out.push(b.subarray(i, j));
      i = j;
    }
  }
  if (orientation !== 1) out.splice(insertAt, 0, orientationApp1(orientation));
  return concat(out);
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
export function stripPng(b) {
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32(b, i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) throw new Error('png');
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(out);
}

export function stripWebp(b) {
  const out = [];
  let i = 12;
  let vp8x = null;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    const size = u32(b, i + 4, true);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > b.length) throw new Error('webp');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = b.slice(i, Math.min(end, b.length));
      if (type === 'VP8X') vp8x = chunk;
      out.push(chunk);
    }
    i = end;
  }
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // no EXIF / XMP flags
  const body = concat(out);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  const size = body.length + 4;
  head.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}

// -> { file, cleaned: true } for JPEG/PNG/WebP, { file, cleaned: false } otherwise
export async function stripMetadata(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  const kind = kindOf(b);
  if (!kind) return { file, cleaned: false };
  const out = { jpeg: stripJpeg, png: stripPng, webp: stripWebp }[kind](b);
  return { file: new File([out], file.name, { type: file.type, lastModified: 0 }), cleaned: true };
}
