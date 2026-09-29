// 事件墙: redaction editor for a photo before upload (mosaic or black box, drawn by dragging).
// Everything happens in this page; the result is re-drawn from pixels on a canvas, so it
// carries no metadata. Mosaic blocks are large on purpose: small ones can be partly undone.
const MAX_EDGE = 2560;

async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// Averages each block inside the rectangle. Blocks are at least `minBlock` and at least 1/6
// of the box's shorter side, so any box (a face, say) is at most about 6 blocks across:
// coarse enough that it cannot be sharpened back into something recognisable.
function mosaic(ctx, r, minBlock) {
  const block = Math.max(minBlock, Math.ceil(Math.min(r.w, r.h) / 6));
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(r.y + r.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const bw = Math.min(block, w - bx);
      const bh = Math.min(block, h - by);
      let rs = 0, gs = 0, bs = 0;
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const i = (y * w + x) * 4;
          rs += d[i];
          gs += d[i + 1];
          bs += d[i + 2];
        }
      }
      const n = bw * bh;
      const [R, G, B] = [rs / n, gs / n, bs / n];
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const i = (y * w + x) * 4;
          d[i] = R;
          d[i + 1] = G;
          d[i + 2] = B;
          d[i + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, x0, y0);
}

// Opens the editor for `file`; resolves to a new File, or null when cancelled
export function redact(file) {
  const dialog = document.getElementById('editor');
  const canvas = document.getElementById('editor-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const toolButtons = [...dialog.querySelectorAll('[data-tool]')];
  const undoBtn = dialog.querySelector('#editor-undo');
  const hint = dialog.querySelector('#editor-hint');

  return new Promise(async (resolve) => {
    let bitmap;
    try {
      bitmap = await loadBitmap(file);
    } catch {
      resolve(null);
      return;
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const block = Math.max(16, Math.round(Math.max(canvas.width, canvas.height) / 40));
    const rects = [];
    let tool = 'mosaic';
    let drag = null;

    const render = (preview) => {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const r of rects) {
        if (r.tool === 'black') {
          ctx.fillStyle = '#000';
          ctx.fillRect(r.x, r.y, r.w, r.h);
        } else mosaic(ctx, r, block);
      }
      if (preview) {
        ctx.save();
        ctx.lineWidth = Math.max(2, canvas.width / 400);
        ctx.strokeStyle = '#ff3b30';
        ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 3]);
        ctx.strokeRect(preview.x, preview.y, preview.w, preview.h);
        ctx.restore();
      }
      undoBtn.disabled = rects.length === 0;
      hint.textContent = rects.length ? `已处理 ${rects.length} 处` : '在图片上拖动，框出要遮住的地方（人脸、车牌、门牌、屏幕等）';
    };

    const point = (e) => {
      const b = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(canvas.width, ((e.clientX - b.left) / b.width) * canvas.width)),
        y: Math.max(0, Math.min(canvas.height, ((e.clientY - b.top) / b.height) * canvas.height)),
      };
    };
    const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

    const onDown = (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drag = point(e);
    };
    const onMove = (e) => {
      if (!drag) return;
      render(box(drag, point(e)));
    };
    const onUp = (e) => {
      if (!drag) return;
      const r = box(drag, point(e));
      drag = null;
      // Ignore taps; tiny boxes are enlarged to one mosaic block
      if (r.w > 3 || r.h > 3) rects.push({ tool, x: r.x, y: r.y, w: Math.max(r.w, block), h: Math.max(r.h, block) });
      render();
    };
    const onTool = (e) => {
      tool = e.currentTarget.dataset.tool;
      for (const b of toolButtons) b.setAttribute('aria-pressed', String(b === e.currentTarget));
    };
    const onUndo = () => {
      rects.pop();
      render();
    };

    const finish = async (ok) => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      for (const b of toolButtons) b.removeEventListener('click', onTool);
      undoBtn.removeEventListener('click', onUndo);
      dialog.removeEventListener('cancel', onCancel);
      dialog.querySelector('#editor-done').onclick = null;
      dialog.querySelector('#editor-cancel').onclick = null;
      let out = null;
      if (ok && rects.length) {
        render();
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise((r) => canvas.toBlob(r, type, 0.92));
        if (blob) out = new File([blob], type === 'image/png' ? 'image.png' : 'image.jpg', { type, lastModified: 0 });
      }
      bitmap.close?.();
      canvas.width = canvas.height = 1; // free the pixels
      dialog.close();
      resolve(ok && !rects.length ? file : out);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(false);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    for (const b of toolButtons) {
      b.addEventListener('click', onTool);
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    }
    undoBtn.addEventListener('click', onUndo);
    dialog.addEventListener('cancel', onCancel);
    dialog.querySelector('#editor-done').onclick = () => finish(true);
    dialog.querySelector('#editor-cancel').onclick = () => finish(false);
    render();
    dialog.showModal();
  });
}
