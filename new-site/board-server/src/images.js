// Re-encodes every uploaded image on the server, after the metadata strip:
//   - applies the orientation, then resizes to at most MAX_EDGE px on the long side
//   - converts to sRGB and drops every profile and metadata block (sharp keeps none by default)
//   - encodes again with this server's own settings
// Decoding and re-encoding replaces the camera's own compression tables and quantisation (which
// hint at the phone model) and, with the downscale, blurs the sensor noise pattern that could
// match a photo to the phone that took it. One image at a time, to stay inside the memory limit.
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

export const MAX_EDGE = 2048;
const MAX_INPUT_PIXELS = 60_000_000; // e.g. 8000 x 7500; larger inputs are refused

let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

// kind: 'jpeg' | 'png' | 'webp' -> Buffer in the same format
export function reencode(input, kind) {
  return serial(async () => {
    let img = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb');
    if (kind === 'png') img = img.png({ compressionLevel: 9, palette: false });
    else if (kind === 'webp') img = img.webp({ quality: 80, effort: 4 });
    else img = img.jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:2:0' });
    return img.toBuffer();
  });
}
