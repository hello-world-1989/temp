import { $, api, esc } from './site.js';

// 直播中转 relays (https://<ip>:8443/): their own page hands out push addresses.
const ok = (r) => /^https:\/\/\d{1,3}(\.\d{1,3}){3}:8443\/$/.test(r.url || '');

async function load() {
  const box = $('#relay-list');
  let relays = [];
  try {
    relays = ((await api('/api/live-relays')).relays || []).filter(ok);
  } catch {}
  if (!relays.length) {
    box.innerHTML = '<div class="notice warn">中转服务器暂时无法加载（可能正在换地址），请过几分钟刷新。</div>';
    return;
  }
  box.innerHTML = relays
    .map(
      (r, i) => `<article class="card feature">
        <h3>中转服务器 ${i + 1}${r.region ? ` <span class="muted">· ${esc(r.region)}</span>` : ''}</h3>
        <p><a class="btn btn-primary" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">打开，申请推流地址</a></p>
        <button class="copy-box" type="button" data-copy="${esc(r.url)}"><code>${esc(r.url)}</code><span class="copy-hint">点击复制</span></button>
      </article>`,
    )
    .join('');
}

load();
