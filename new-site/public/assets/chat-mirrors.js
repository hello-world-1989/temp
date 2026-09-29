import { $, api, esc } from './site.js';

// The 加密聊天 relays (https://<ip>:8443/chat). Only addresses that start with https:// and
// point at the chat page are shown.
const ok = (m) => /^https:\/\/\d{1,3}(\.\d{1,3}){3}:8443\/chat$/.test(m.url || '');

async function load() {
  const box = $('#chat-list');
  let mirrors = [];
  try {
    mirrors = ((await api('/api/chat-mirrors')).mirrors || []).filter(ok);
  } catch {}
  if (!mirrors.length) {
    box.innerHTML = '<div class="notice warn">备用入口暂时无法加载，请稍后刷新，或直接在本站打开。</div>';
    return;
  }
  box.innerHTML = mirrors
    .map(
      (m, i) => `<article class="card feature">
        <h3>备用入口 ${i + 1}${m.region ? ` <span class="muted">· ${esc(m.region)}</span>` : ''}</h3>
        <p><a class="btn btn-primary" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开聊天</a></p>
        <button class="copy-box" type="button" data-copy="${esc(m.url)}"><code>${esc(m.url)}</code><span class="copy-hint">点击复制</span></button>
      </article>`,
    )
    .join('');
}

load();
