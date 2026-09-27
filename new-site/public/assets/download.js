import { $, api, esc, safeUrl } from './site.js';

const OS = ['android', 'ios', 'windows', 'mac', 'linux'];
// Clients that import a subscription link from the paid service
const SUBSCRIPTION_CLIENTS = /hiddify|v2ray|clash|karing|shadowrocket|nekobox|sing-?box|stash|quantumult/i;

// Help links of the old site pointed at anchors on its home page
const HELP = {
  '/index.html#hiddify_sub': '/faq#hiddify',
  '/index.html#v2ray_sub': '/faq#v2ray',
  '/index.html#karing_sub': '/faq#karing',
  '/index.html#outline': '/faq#outline',
};
const helpHref = (h) => HELP[h] || (h && !/^https?:/.test(h) ? `https://end-gfw.com/${h.replace(/^\//, '')}` : h);

const icon = (img) => (img && !/^https?:/.test(img) ? `/${img.replace(/^\//, '')}` : '/favicon.svg');

let apps = [];

function card(a) {
  const stars = Math.max(0, Math.min(10, Number(a.star) || 0));
  const sub = SUBSCRIPTION_CLIENTS.test(`${a.id} ${a.name}`);
  const buttons = [
    a.link1 ? `<a class="btn btn-primary btn-sm" href="${esc(safeUrl(a.link1))}" rel="nofollow">本站下载</a>` : '',
    a.link2 ? `<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(a.link2))}" rel="noopener nofollow">GitHub</a>` : '',
    a.mainLink ? `<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(a.mainLink))}" rel="noopener nofollow">${esc(a.mainText || '官网')}</a>` : '',
    a.helpLink ? `<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(helpHref(a.helpLink)))}">${esc(a.helpText || '使用说明')}</a>` : '',
  ].join('');
  return `<article class="card app">
    <div class="app-head">
      <img src="${esc(icon(a.image))}" alt="" loading="lazy" width="44" height="44">
      <div><h3>${esc(a.name)}</h3>
      <div class="meta">${stars ? `<span class="stars" aria-label="推荐指数 ${stars}/10">${'★'.repeat(Math.round(stars / 2))}</span> ` : ''}${sub ? '<span class="badge soft">支持订阅</span> ' : ''}${esc(a.date || '')}</div></div>
    </div>
    <p>${esc(a.comment || '')}</p>
    <div class="row">${buttons}</div>
  </article>`;
}

function show(os) {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.os === os)));
  const list = apps.filter((a) => a.os === os).sort((a, b) => (Number(b.star) || 0) - (Number(a.star) || 0));
  $('#apps').innerHTML = list.length ? list.map(card).join('') : '<p class="muted">这个系统暂时没有推荐的软件。</p>';
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  history.replaceState(null, '', `#${tab.dataset.os}`);
  show(tab.dataset.os);
});

async function init() {
  try {
    apps = await api('/api/apps');
  } catch {
    $('#apps').innerHTML = '<div class="notice warn">软件列表暂时无法加载，请稍后刷新。</div>';
    return;
  }
  const hash = location.hash.slice(1);
  show(OS.includes(hash) ? hash : 'android');
}

init();
