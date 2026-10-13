// 常用工具 /tools — everything runs locally in the browser; nothing is sent anywhere.
import { $, toast, copyText } from './site.js';
import qrcode from './vendor/qrcode.js';
import {
  b64decode, b64decodeBytes, b64encode, looksLikeText,
  splitInput, parseAll, toClash, toLinks, toBase64Sub,
} from './tools-convert.js';

const msg = (el, text, kind = '') => {
  el.className = 'notice' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
};

// ---------- tabs (#qr, #scan, …) ----------
const tabs = [...document.querySelectorAll('.tool-tabs .tab')];
function show(name) {
  if (!tabs.some((t) => t.dataset.tool === name)) name = 'qr';
  for (const t of tabs) {
    const on = t.dataset.tool === name;
    t.setAttribute('aria-selected', String(on));
    $('#tool-' + t.dataset.tool).classList.toggle('active', on);
  }
}
for (const t of tabs) {
  t.addEventListener('click', () => {
    history.replaceState(null, '', '#' + t.dataset.tool);
    show(t.dataset.tool);
  });
}
addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));

function goTo(name, fill) {
  history.replaceState(null, '', '#' + name);
  show(name);
  fill?.();
  window.scrollTo({ top: $('.tool-tabs').offsetTop - 70, behavior: 'smooth' });
}

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- QR generate ----------
const qrText = $('#qr-text');
const qrCanvas = $('#qr-canvas');
function drawQr() {
  const text = qrText.value;
  const size = Number($('#qr-size').value);
  const ctx = qrCanvas.getContext('2d');
  qrCanvas.width = qrCanvas.height = size;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  const info = $('#qr-info');
  if (!text) {
    info.textContent = '';
    return;
  }
  let qr;
  try {
    qr = qrcode(0, $('#qr-ecc').value);
    qr.addData(unescape(encodeURIComponent(text))); // UTF-8 bytes
    qr.make();
  } catch {
    info.textContent = '内容太长，放不进一个二维码。试试把纠错改成“低”，或缩短内容。';
    return;
  }
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor((c + quiet) * cell), Math.floor((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }
  info.textContent = `${text.length} 个字符，${n}×${n} 格。${n > 80 ? '格子较密，扫不出来时把纠错改成“低”或保存大图。' : ''}`;
}
qrText.addEventListener('input', drawQr);
$('#qr-ecc').addEventListener('change', drawQr);
$('#qr-size').addEventListener('change', drawQr);
$('#qr-download').addEventListener('click', () => {
  if (!qrText.value) return toast('先输入内容');
  qrCanvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qrcode.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
});
drawQr();

// ---------- QR scan ----------
const scanMsg = $('#scan-msg');
let jsQR;
async function decodeImage(blob) {
  msg(scanMsg, '正在识别…');
  $('#scan-result-box').classList.add('hidden');
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return msg(scanMsg, '打不开这张图片', 'error');
  }
  let text = null;
  // Native detector first (Chrome/Android/Safari 17+), then jsQR at a few sizes
  if ('BarcodeDetector' in window) {
    try {
      const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
      if (found.length) text = found[0].rawValue;
    } catch {}
  }
  if (text == null) {
    jsQR ||= (await import('./vendor/jsqr.js')).default;
    const canvas = $('#scan-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const longest = Math.max(bitmap.width, bitmap.height);
    for (const target of [Math.min(longest, 1600), 1000, 600, longest]) {
      const scale = Math.min(1, target / longest);
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (r) {
        text = r.data;
        break;
      }
    }
  }
  if (text == null) return msg(scanMsg, '没找到二维码。试试只截二维码那一块、截清楚一点的图。', 'warn');
  msg(scanMsg, '识别成功', 'ok');
  $('#scan-result').value = text;
  $('#scan-result-box').classList.remove('hidden');
}
const scanDrop = $('#scan-drop');
$('#scan-file').addEventListener('change', (e) => e.target.files[0] && decodeImage(e.target.files[0]));
for (const [drop, onFile] of [[scanDrop, decodeImage], [$('#hash-drop'), hashFile]]) {
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  goTo('scan');
  decodeImage(item.getAsFile());
});
$('#scan-copy').addEventListener('click', () => copyText($('#scan-result').value));
$('#scan-to-convert').addEventListener('click', () => goTo('convert', () => { $('#cv-in').value = $('#scan-result').value; convert(); }));
$('#scan-to-base64').addEventListener('click', () => goTo('base64', () => { $('#b64-in').value = $('#scan-result').value; b64Decode(); }));

// ---------- subscription / config conversion ----------
const cvMsg = $('#cv-msg');
let lastNodes = [];
function convert() {
  const out = $('#cv-out').value;
  $('#cv-nodes').replaceChildren();
  $('#cv-result-box').classList.add('hidden');
  let lines;
  try {
    lines = splitInput($('#cv-in').value);
  } catch (err) {
    return msg(cvMsg, err.message, 'warn');
  }
  if (!lines.length) return msg(cvMsg, '先粘贴订阅内容或节点链接', 'warn');
  const { nodes, errors } = parseAll(lines);
  lastNodes = nodes;
  if (!nodes.length) {
    return msg(cvMsg, `没有能识别的节点。${errors[0] ? `第 ${errors[0].line} 行：${errors[0].error}` : ''}`, 'error');
  }
  msg(cvMsg, `识别出 ${nodes.length} 个节点${errors.length ? `，跳过 ${errors.length} 行（${errors.slice(0, 3).map((e) => `第 ${e.line} 行：${e.error}`).join('；')}）` : ''}`, errors.length ? 'warn' : 'ok');
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'node';
    const badge = document.createElement('span');
    badge.className = 'badge soft';
    badge.textContent = n.type === 'hysteria2' ? 'hy2' : n.type;
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = n.name;
    const addr = document.createElement('div');
    addr.className = 'addr';
    addr.textContent = `${n.server}:${n.ports || n.port}${n['reality-opts'] ? ' · REALITY' : n.tls ? ' · TLS' : ''}${n.network && n.network !== 'tcp' ? ' · ' + n.network : ''}`;
    info.append(name, addr);
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.type = 'button';
    btn.textContent = '二维码';
    btn.addEventListener('click', () => goTo('qr', () => { qrText.value = n.link; $('#qr-ecc').value = 'L'; drawQr(); }));
    row.append(badge, info, btn);
    $('#cv-nodes').append(row);
  }
  const text = out === 'base64' ? toBase64Sub(nodes) : out === 'links' ? toLinks(nodes) : toClash(nodes, out);
  $('#cv-result').value = text;
  $('#cv-result-box').classList.remove('hidden');
}
$('#cv-go').addEventListener('click', convert);
$('#cv-out').addEventListener('change', () => lastNodes.length && convert());
$('#cv-copy').addEventListener('click', () => copyText($('#cv-result').value));
$('#cv-download').addEventListener('click', () => {
  const out = $('#cv-out').value;
  const yaml = out.startsWith('clash') || out === 'proxies';
  download(yaml ? 'config.yaml' : 'subscription.txt', $('#cv-result').value, yaml ? 'text/yaml' : 'text/plain');
});

// ---------- Base64 ----------
const b64Msg = $('#b64-msg');
function b64Decode() {
  const input = $('#b64-in').value.trim();
  if (!input) return msg(b64Msg, '先输入内容', 'warn');
  try {
    const text = b64decode(input);
    if (looksLikeText(text)) {
      $('#b64-out').value = text;
      msg(b64Msg, '');
    } else {
      const bytes = b64decodeBytes(input);
      $('#b64-out').value = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      msg(b64Msg, '解码结果不是文字（二进制数据），以十六进制显示', 'warn');
    }
  } catch (err) {
    msg(b64Msg, err.message, 'error');
  }
}
$('#b64-decode').addEventListener('click', b64Decode);
$('#b64-encode').addEventListener('click', () => {
  $('#b64-out').value = b64encode($('#b64-in').value, $('#b64-urlsafe').checked);
  msg(b64Msg, '');
});
$('#b64-copy').addEventListener('click', () => copyText($('#b64-out').value));

// ---------- URL encode / decode ----------
const urlMsg = $('#url-msg');
$('#url-decode').addEventListener('click', () => {
  try {
    $('#url-out').value = decodeURIComponent($('#url-in').value.replace(/\+/g, ' '));
    msg(urlMsg, '');
  } catch {
    msg(urlMsg, '有不完整的 % 编码，无法解码', 'error');
  }
});
$('#url-encode').addEventListener('click', () => {
  $('#url-out').value = encodeURIComponent($('#url-in').value);
  msg(urlMsg, '');
});
$('#url-copy').addEventListener('click', () => copyText($('#url-out').value));

// ---------- SHA-256 file check ----------
const hashMsg = $('#hash-msg');
let lastHash = '';
function compareHash() {
  const expect = $('#hash-expect').value.trim().toLowerCase().replace(/^sha256[:=]\s*/, '');
  if (!lastHash) return;
  if (!expect) return msg(hashMsg, '计算完成。把结果和官网写的值对比。', 'ok');
  if (expect === lastHash) msg(hashMsg, '✓ 一致：文件没有被改动', 'ok');
  else msg(hashMsg, '✗ 不一致：文件可能下载不完整或被调包，不要安装', 'error');
}
async function hashFile(file) {
  if (!crypto.subtle) return msg(hashMsg, '这个浏览器不支持（需要 https 页面）', 'error');
  if (file.size > 2 * 1024 ** 3) return msg(hashMsg, '文件超过 2 GB，浏览器算不了', 'error');
  msg(hashMsg, `正在计算 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）…`);
  $('#hash-result').classList.add('hidden');
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    lastHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return msg(hashMsg, '读取文件失败（文件太大或内存不够）', 'error');
  }
  $('#hash-name').textContent = file.name;
  $('#hash-value').textContent = lastHash;
  $('#hash-result').classList.remove('hidden');
  compareHash();
}
$('#hash-file').addEventListener('change', (e) => e.target.files[0] && hashFile(e.target.files[0]));
$('#hash-expect').addEventListener('input', compareHash);
$('#hash-value').addEventListener('click', () => copyText(lastHash));

// ---------- password / UUID ----------
function randomInt(max) {
  // Rejection sampling, no modulo bias
  const lim = Math.floor(0x100000000 / max) * max;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= lim);
  return a[0] % max;
}
const genOut = $('#gen-out');
function setGen(v) {
  genOut.value = v;
  copyText(v);
}
$('#gen-pass').addEventListener('click', () => {
  const len = Math.min(128, Math.max(8, Number($('#gen-len').value) || 24));
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' + ($('#gen-symbols').checked ? '!@#%^*-_=+.' : '');
  setGen(Array.from({ length: len }, () => chars[randomInt(chars.length)]).join(''));
});
$('#gen-uuid').addEventListener('click', () => setGen(crypto.randomUUID ? crypto.randomUUID() : fallbackUuid()));
$('#gen-ss').addEventListener('click', () => {
  // 2022-blake3-aes-256-gcm / chacha20 needs a 32-byte base64 key (aes-128 uses 16)
  const key = crypto.getRandomValues(new Uint8Array(32));
  setGen(btoa(String.fromCharCode(...key)));
  toast('32 字节密钥，用于 2022-blake3-aes-256-gcm');
});
genOut.addEventListener('click', () => genOut.value && copyText(genOut.value));
function fallbackUuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
