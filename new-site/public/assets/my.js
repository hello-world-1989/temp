import { $, api, esc, fmtDate, fmtBytes, tokenStore } from './site.js';
import qrcode from './vendor/qrcode.js';

// SVG QR code for a link; type 0 picks the smallest size that fits
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function renderQrs(root) {
  for (const el of root.querySelectorAll('[data-qr]')) {
    if (!el.firstChild) el.innerHTML = qrSvg(el.getAttribute('data-qr'));
  }
}

const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;

// Accept a bare token or any link carrying ?token=
function extractToken(input) {
  const v = String(input || '').trim();
  if (TOKEN_RE.test(v)) return v;
  const m = v.match(/[?&]token=([A-Za-z0-9-]{8,64})/);
  return m ? m[1] : '';
}

function msg(el, text, kind = '') {
  el.className = `notice mt ${kind}`;
  el.textContent = text;
}

const TIER_NAMES = { free: '免费', youtube: 'YouTube' };
const tierName = (t) => TIER_NAMES[t] || (/^p\d$/.test(t) ? `套餐${t.slice(1)}` : t);

// The first link (main V2Ray subscription) shows its QR code open; others on demand
function linkRows(label, links, openFirst = false) {
  const rows = [
    ['V2Ray / Hiddify / Shadowrocket', links.v2ray],
    ['Clash / Clash Verge', links.clash],
    ['Outline', links.outline],
  ].filter(([, url]) => url);
  return rows
    .map(
      ([name, url], i) => `<div class="link-row">
        <div class="label"><b>${esc(name)}</b>${label ? `<br><span class="muted">${esc(label)}</span>` : ''}</div>
        <code>${esc(url)}</code>
        <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(url)}">复制</button>
        <details class="qr-toggle"${openFirst && i === 0 ? ' open' : ''}><summary>二维码</summary><div class="qr" data-qr="${esc(url)}" aria-label="${esc(name)} 订阅二维码"></div></details>
      </div>`,
    )
    .join('');
}

function render(user) {
  const expires = new Date(user.expiresAt);
  const active = expires > new Date();
  const days = Math.ceil((expires - new Date()) / 86400000);
  const paid = (user.tiers || []).filter((t) => /^p\d$/.test(t));
  $('#status').innerHTML = [
    ['状态', active ? `<span class="badge ok">有效</span>` : `<span class="badge warn">已过期</span>`],
    ['套餐', esc(paid.length ? paid.map(tierName).join('、') : '免费')],
    ['到期时间', esc(fmtDate(user.expiresAt))],
    ['剩余', active ? `${esc(days)} 天` : '—'],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  const links = user.links || {};
  $('#links').innerHTML =
    linkRows('', links, true) + (links.backups || []).map((b, i) => linkRows(`备用链接 ${i + 1}`, b)).join('');
  for (const d of $('#links').querySelectorAll('details[open]')) renderQrs(d);

  const months = Object.entries(user.traffic || {}).sort(([a], [b]) => b.localeCompare(a)).slice(0, 3);
  $('#traffic').innerHTML = months.length
    ? months
        .map(([ym, t]) => `<div><dt>${esc(ym.slice(0, 4))} 年 ${esc(ym.slice(4))} 月</dt><dd>${esc(fmtBytes((t.up || 0) + (t.down || 0)))}</dd></div>`)
        .join('')
    : '<div><dt>本月</dt><dd>暂无流量</dd></div>';

  $("#extend").href = "/plans?renew=1#buy";
  $('#result').classList.remove('hidden');
}

async function lookup(token) {
  const out = $('#lookup-msg');
  msg(out, '查询中…');
  try {
    const user = await api(`/api/user?token=${encodeURIComponent(token)}`);
    tokenStore.set(token);
    msg(out, '');
    render(user);
  } catch (err) {
    $('#result').classList.add('hidden');
    msg(out, err.status === 404 ? '没有找到这个订阅，请检查 token 是否完整。' : err.message, 'error');
  }
}

$('#lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  const token = extractToken($('#token').value);
  if (!token) return msg($('#lookup-msg'), '请输入订阅 token，或粘贴完整的订阅链接。', 'error');
  $('#token').value = token;
  history.replaceState(null, '', location.pathname);
  lookup(token);
});

$('#renew').addEventListener('click', async () => {
  const token = tokenStore.get();
  const out = $('#renew-msg');
  if (!token) return;
  $('#renew').disabled = true;
  msg(out, '签到中…');
  try {
    const user = await api(`/api/renew?token=${encodeURIComponent(token)}`);
    render(user);
    msg($('#renew-msg'), `签到成功，到期时间：${fmtDate(user.expiresAt)}`, 'ok');
  } catch (err) {
    msg(out, err.message || '签到失败，请稍后再试', 'error');
  } finally {
    $('#renew').disabled = false;
  }
});

// QR codes for collapsed rows are drawn when opened
$('#links').addEventListener('toggle', (e) => e.target.open && renderQrs(e.target), true);

$('#forget').addEventListener('click', () => {
  tokenStore.set('');
  $('#token').value = '';
  $('#result').classList.add('hidden');
  msg($('#lookup-msg'), '已从这台设备移除。', 'ok');
});

// ?token=… (e.g. from the success page or an email) or the remembered token
const initial = extractToken(new URLSearchParams(location.search).get('token') || '') || tokenStore.get();
if (initial) {
  $('#token').value = initial;
  // Keep the token out of the address bar and browser history
  if (location.search) history.replaceState(null, '', location.pathname);
  lookup(initial);
}
