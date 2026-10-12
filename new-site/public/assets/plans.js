import { $, api, esc, fmtPrice, tokenStore } from './site.js';
import { planCard } from './plans-common.js';

const params = new URLSearchParams(location.search);
const form = $('#buy-form');
const msg = $('#buy-msg');
let plans = [];

function setMsg(text, kind = '') {
  msg.className = `notice mt ${kind}`;
  msg.textContent = text;
}

function setMode(mode) {
  $('#email-field').classList.toggle('hidden', mode !== 'new');
  $('#token-field').classList.toggle('hidden', mode !== 'renew');
  form.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === mode));
}

async function init() {
  try {
    plans = await api('/api/plans');
  } catch {
    $('#plans').innerHTML = '<div class="notice warn">赞助档位暂时无法加载，请稍后刷新。</div>';
    return;
  }
  $('#plans').innerHTML = plans.map((p, i) => planCard(p, { featured: i === 1 })).join('');
  $('#plan').innerHTML = plans
    .map((p) => `<option value="${esc(p.plan)}">${esc(p.mbit)} Mbps · ${esc(fmtPrice(p.priceCents, p.currency))} / ${esc(p.days)} 天</option>`)
    .join('');
  const wanted = params.get('plan');
  if (wanted && plans.some((p) => String(p.plan) === wanted)) $('#plan').value = wanted;
  else if (plans[1]) $('#plan').value = String(plans[1].plan);
  const max = Math.max(1, Number(plans[0]?.maxMonths) || 1);
  $('#months').querySelectorAll('option').forEach((o) => { if (Number(o.value) > max) o.remove(); });
  const m = params.get('months');
  if (m && $('#months').querySelector(`option[value="${CSS.escape(m)}"]`)) $('#months').value = m;
  updateTotal();

  const saved = params.get('token') || tokenStore.get();
  if (saved) {
    $('#token').value = saved;
    if (params.get('token') || params.get('renew')) setMode('renew');
  }
}

// Shows unit price × months = total; Stripe charges the same (quantity = months)
function updateTotal() {
  const p = plans.find((x) => String(x.plan) === $('#plan').value);
  const months = Number($('#months').value) || 1;
  if (!p) return ($('#total').textContent = '');
  const days = (p.days || 30) * months;
  $('#total').innerHTML = `合计：<b>${esc(fmtPrice(p.priceCents * months, p.currency))}</b>` +
    (months > 1 ? ` <span class="muted">（${esc(fmtPrice(p.priceCents, p.currency))} × ${months} 个月，共 ${days} 天）</span>` : ` <span class="muted">（${days} 天）</span>`);
  $('#pay').textContent = `前往付款 ${fmtPrice(p.priceCents * months, p.currency)}`;
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'mode') setMode(e.target.value);
  if (e.target.id === 'plan' || e.target.id === 'months') updateTotal();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = form.querySelector('input[name=mode]:checked').value;
  const plan = $('#plan').value;
  const q = new URLSearchParams({ plan, months: $('#months').value || '1' });
  if (mode === 'new') {
    const email = $('#email').value.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setMsg('邮箱格式不正确', 'error');
    if (email) q.set('email', email);
  } else {
    const token = $('#token').value.trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) return setMsg('请填写正确的订阅 token', 'error');
    q.set('token', token);
    tokenStore.set(token);
  }
  const btn = $('#pay');
  btn.disabled = true;
  setMsg('正在打开付款页…');
  try {
    const data = await api(`/api/checkout?${q}`);
    if (!data?.url || !/^https:\/\/checkout\.stripe\.com\//.test(data.url)) throw new Error('付款页地址异常，请稍后再试');
    location.href = data.url;
  } catch (err) {
    setMsg(err.message || '无法创建付款，请稍后再试', 'error');
    btn.disabled = false;
  }
});

init();
