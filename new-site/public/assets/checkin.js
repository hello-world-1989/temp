import { $, api, fmtDate, tokenStore } from './site.js';

function msg(el, text, kind = '') {
  el.className = `notice mt ${kind}`;
  el.textContent = text;
}

function bind(formId, inputId, buttonId, msgId, run) {
  $(formId).addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $(inputId).value.trim();
    const out = $(msgId);
    if (!value) return msg(out, '请先填写', 'warn');
    $(buttonId).disabled = true;
    msg(out, '签到中…');
    try {
      msg(out, await run(value), 'ok');
    } catch (err) {
      msg(out, err.message || '签到失败，请稍后再试', 'error');
    } finally {
      $(buttonId).disabled = false;
    }
  });
}

bind('#id-form', '#token', '#id-submit', '#id-msg', async (value) => {
  const r = await api(`/api/checkin/id?token=${encodeURIComponent(value)}`);
  return r.expiresAt ? `签到成功，订阅到期时间：${fmtDate(r.expiresAt)}` : '签到成功，订阅已延长。请在客户端里更新订阅。';
});

bind('#email-form', '#email', '#email-submit', '#email-msg', async (value) => {
  const r = await api(`/api/checkin/email?email=${encodeURIComponent(value)}`);
  return r.expiresAt ? `签到成功，有效期到：${fmtDate(r.expiresAt)}` : '签到成功';
});

// Prefill from ?token= / ?email= or the token saved on "我的订阅"
const params = new URLSearchParams(location.search);
$('#token').value = params.get('token') || tokenStore.get() || '';
$('#email').value = params.get('email') || '';
// Keep tokens and addresses out of the address bar and history
if (params.has('token') || params.has('email')) history.replaceState(null, '', location.pathname);
