import { $, api, esc, ymd, addDays } from './site.js';
import qrcode from './vendor/qrcode.js';

// SVG QR code for a link; type 0 picks the smallest size that fits
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function renderQrs(root = document) {
  for (const el of root.querySelectorAll('[data-qr]')) {
    if (!el.firstChild) el.innerHTML = qrSvg(el.getAttribute('data-qr'));
  }
}

// Free VLESS / Shadowsocks nodes from the published free subscription
function setSub(kind, url) {
  const btn = $(`#sub-${kind}`);
  const qr = $(`#qr-${kind}`);
  if (!btn) return;
  if (!url) {
    btn.querySelector('code').textContent = '订阅链接暂时无法加载，请稍后刷新，或使用下面的 GitHub 订阅。';
    return;
  }
  btn.setAttribute('data-copy', url);
  btn.querySelector('code').textContent = url;
  if (qr) qr.innerHTML = qrSvg(url);
}

async function loadFreeNodes() {
  const box = $('#free-nodes');
  let nodes = [];
  let links = [];
  try {
    const data = await api('/api/free');
    links = data.links || [];
    nodes = data.nodes.filter((n) => n.protocol === 'VLESS' || n.protocol === 'Shadowsocks');
  } catch {}
  setSub('v2ray', links[0]?.v2ray);
  setSub('clash', links[0]?.clash);
  const backup = $('#sub-backup');
  if (backup && links.length > 1) {
    backup.innerHTML = '备用域名：' + links.slice(1).map((l) => `<code>${esc(l.v2ray)}</code>（Clash 把 /sub 换成 /clash）`).join('；');
  }
  if (!nodes.length) {
    box.innerHTML = '<div class="notice warn">免费节点暂时无法加载，请稍后刷新，或使用上面的订阅链接。</div>';
    return;
  }
  box.innerHTML = nodes
    .map(
      (n) => `<article class="card feature node-card">
        <div class="item-meta"><span class="badge soft">${esc(n.protocol)}</span><span>${esc(n.name)}</span></div>
        <button class="copy-box" type="button" data-copy="${esc(n.uri)}"><code>${esc(n.uri)}</code><span class="copy-hint">点击复制</span></button>
        <details class="qr-toggle"><summary>显示二维码</summary><div class="qr" data-qr="${esc(n.uri)}" aria-label="${esc(n.name)} 二维码"></div></details>
      </article>`,
    )
    .join('');
  // Node QR codes are drawn when opened; long links make dense codes
  box.addEventListener('toggle', (e) => e.target.open && renderQrs(e.target), true);
}

async function loadNews() {
  const box = $('#news');
  let date = ymd();
  let items = [];
  // Today's file may not exist yet early in the day; fall back up to two days
  for (let i = 0; i < 3 && items.length === 0; i++) {
    try {
      items = await api(`/api/news?date=${date}`);
    } catch {
      items = [];
    }
    if (!items.length) date = addDays(date, -1);
  }
  if (!items.length) {
    box.innerHTML = '<p class="muted">暂时没有新闻。</p>';
    return;
  }
  box.innerHTML = items
    .slice(0, 6)
    .map(
      (n) => `<a class="card item" href="/news?date=${esc(date)}#n${esc(n.id)}">
        <div class="item-meta"><span class="badge soft">${esc(n.name || n.sourceId)}</span><span>${esc(n.createdDate)}</span></div>
        <h3>${esc(n.title)}</h3>
        <p class="muted">${esc(String(n.content || '').slice(0, 80))}…</p>
      </a>`,
    )
    .join('');
}

renderQrs();
loadFreeNodes();
loadNews();
