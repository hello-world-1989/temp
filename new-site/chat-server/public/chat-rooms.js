// 公开事件群: the public list with 申请加入, 我的申请, and the owner's panel (publish, approve).
// Crypto is in chat-crypto.js (owner key, sealJoin/openJoin); the server only relays sealed blobs.
// All text is set with textContent.
import {
  b64url, boxOwnerKey, exportEcdh, fragment, fromB64url, importEcdh, kvGet, kvPut, newEcdh, openJoin,
  proofOfWork, randomBytes, sealJoin, unboxOwnerKey,
} from './chat-crypto.js';

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
  return data;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const when = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---- requests this device has made (IndexedDB: the request key pair and its secret) -----------

const loadJoins = async () => (await kvGet('joins').catch(() => null)) || [];
const saveJoins = (list) => kvPut('joins', list).catch(() => {});

// ---- the list, on the start page ----------------------------------------------------------------

export async function directoryView({ identity, vault }) {
  $('dir').hidden = false;
  const list = $('dir-list');
  let rooms = [];
  try {
    rooms = (await api('/chat/api/directory')).rooms || [];
  } catch {
    $('dir').hidden = true;
    return;
  }
  $('dir-empty').hidden = rooms.length > 0;
  list.replaceChildren();
  for (const r of rooms) {
    const item = el('div', 'dir-item');
    item.append(el('h3', '', r.name));
    if (r.desc) item.append(el('p', 'desc', r.desc));
    const meta = el('p', 'small muted', `${when(r.at)} 公开${r.online ? ` · ${r.online} 人在线` : ''}`);
    const ask = el('button', 'btn btn-sm', '申请加入');
    ask.type = 'button';
    ask.onclick = () => {
      ask.hidden = true;
      item.append(requestForm(r, { identity, vault, done: () => renderMine() }));
    };
    item.append(meta, ask);
    list.append(item);
  }
  await renderMine();
  // Approvals arrive while the page is open
  setInterval(renderMine, 30_000);
}

function requestForm(r, { identity, vault, done }) {
  const form = el('form');
  form.noValidate = true;
  const nick = el('input', 'input');
  nick.maxLength = 20;
  nick.value = vault.nick || '';
  const note = el('textarea', 'input');
  note.rows = 2;
  note.maxLength = 200;
  const l1 = el('label', 'field', '你的昵称（只有群主看得到）');
  l1.append(nick);
  const l2 = el('label', 'field', '给群主的话（可选，只有群主看得到，比如你和这件事的关系）');
  l2.append(note);
  const btn = el('button', 'btn primary', '发送申请');
  btn.type = 'submit';
  const msg = el('p', 'small');
  form.append(l1, l2, btn, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nick.value.trim()) return nick.focus();
    btn.disabled = true;
    try {
      msg.textContent = '正在做一个小计算防止滥用，通常几秒钟…';
      const mine = await newEcdh();
      const secret = randomBytes(32);
      const info = await sealJoin(mine.priv, fromB64url(r.ownerPub), r.room, 'info', { nick: nick.value.trim().slice(0, 20), note: note.value.trim().slice(0, 200), fp: identity?.fp || '' });
      const { challenge, bits } = await api('/chat/api/pow?for=join');
      const pow = await proofOfWork(challenge, bits);
      const { id } = await api('/chat/api/join/request', { room: r.room, reqPub: b64url(mine.pub), info: b64url(info), secret: b64url(secret), pow });
      const joins = await loadJoins();
      joins.unshift({ id, secret: b64url(secret), room: r.room, name: r.name, jwk: await exportEcdh(mine.priv), ownerPub: r.ownerPub, at: Date.now(), status: 'pending' });
      await saveJoins(joins.slice(0, 50));
      form.replaceChildren(el('p', 'small', '已发送，等群主批准。批准后会出现在下面的「我的申请」里。'));
      done();
    } catch (err) {
      msg.textContent = err.message;
      btn.disabled = false;
    }
  });
  return form;
}

// 我的申请: check each pending one; an approval carries the room key sealed to this device
async function renderMine() {
  const joins = await loadJoins();
  let changed = false;
  for (const j of joins) {
    if (j.status !== 'pending') continue;
    try {
      const st = await api('/chat/api/join/status', { id: j.id, secret: j.secret });
      if (st.status === 'approved' && st.sealed) {
        const grant = await openJoin(await importEcdh(j.jwk), fromB64url(st.ownerPub || j.ownerPub), j.room, 'grant', fromB64url(st.sealed));
        Object.assign(j, { status: 'approved', key: grant.key, name: grant.name || j.name });
        delete j.jwk; // no longer needed
        changed = true;
      } else if (st.status === 'rejected') {
        Object.assign(j, { status: 'rejected' });
        delete j.jwk;
        changed = true;
      }
    } catch (err) {
      if (err.status === 404) {
        Object.assign(j, { status: 'expired' });
        changed = true;
      }
    }
  }
  if (changed) await saveJoins(joins);
  const ul = $('my-req');
  ul.replaceChildren();
  $('my-req-box').hidden = !joins.length;
  for (const j of joins) {
    const li = el('li');
    li.append(el('strong', '', j.name), ' ');
    if (j.status === 'approved' && j.key) {
      const a = el('a', '', '已批准，进入群聊');
      a.href = `/chat${fragment(j.room, fromB64url(j.key))}`;
      li.append(a);
    } else {
      li.append(el('span', 'small muted', { pending: '等群主批准…', rejected: '群主没有批准', expired: '申请已过期' }[j.status] || j.status));
    }
    const del = el('button', 'linkish small', '删除');
    del.type = 'button';
    del.onclick = async () => {
      await saveJoins((await loadJoins()).filter((x) => x.id !== j.id));
      renderMine();
    };
    li.append(' ', del);
    ul.append(li);
  }
}

// ---- the owner's panel, in the room ------------------------------------------------------------

export function ownerPanel({ room, key, owner, getName, onCount }) {
  const btn = $('r-manage');
  btn.hidden = false;
  const box = $('r-admin');
  const ownerB64 = b64url(owner);
  let ownerPriv = null;
  let busy = false;
  btn.onclick = () => {
    box.hidden = !box.hidden;
    if (!box.hidden) refresh();
  };

  async function ownerKey(view) {
    if (ownerPriv) return ownerPriv;
    if (view.ownerBox) ownerPriv = await unboxOwnerKey(owner, room, fromB64url(view.ownerBox));
    return ownerPriv;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const v = await api('/chat/api/rooms/owner', { room, owner: ownerB64 });
      const stateText = {
        private: '这个群没有公开，只有拿到邀请链接的人能进。',
        review: '已申请公开，等网站管理员审核。',
        listed: '已公开：出现在事件群列表里，别人可以申请加入。',
        rejected: `没有通过审核${v.reason ? `：${v.reason}` : ''}。可以修改后重新申请。`,
      }[v.state];
      $('ra-state').textContent = stateText;
      if (!$('ra-name').value) $('ra-name').value = v.name || getName() || '';
      if (!$('ra-desc').value) $('ra-desc').value = v.desc || '';
      $('ra-submit').textContent = v.state === 'private' ? '申请公开' : '更新并重新审核';
      $('ra-unpub').hidden = v.state === 'private';
      const ul = $('ra-reqs');
      ul.replaceChildren();
      $('ra-reqs-empty').hidden = v.requests.length > 0;
      onCount(v.requests.length);
      const priv = v.requests.length ? await ownerKey(v) : null;
      for (const rq of v.requests) {
        const li = el('li');
        let info = { nick: '（无法解密）', note: '', fp: '' };
        try {
          info = await openJoin(priv, fromB64url(rq.reqPub), room, 'info', fromB64url(rq.info));
        } catch {}
        li.append(el('strong', '', String(info.nick || '').slice(0, 20)), el('span', 'small muted', ` ${info.fp ? `#${String(info.fp).slice(0, 9)}` : '未签名'} · ${when(rq.at)}`));
        if (info.note) li.append(el('p', 'small', String(info.note).slice(0, 200)));
        const acts = el('div', 'req-actions');
        const ok = el('button', 'btn btn-sm primary', '批准');
        const no = el('button', 'btn btn-sm', '拒绝');
        ok.type = no.type = 'button';
        ok.onclick = () => decide(rq, true, ok);
        no.onclick = () => decide(rq, false, no);
        acts.append(ok, no);
        li.append(acts);
        ul.append(li);
      }
    } catch (err) {
      $('ra-state').textContent = err.message;
    } finally {
      busy = false;
    }
  }

  async function decide(rq, approve, b) {
    b.disabled = true;
    try {
      const body = { room, owner: ownerB64, id: rq.id, approve };
      if (approve) body.sealed = b64url(await sealJoin(ownerPriv, fromB64url(rq.reqPub), room, 'grant', { key: b64url(key), name: getName() }));
      await api('/chat/api/rooms/decide', body);
    } catch (err) {
      alert(err.message);
    }
    refresh();
  }

  $('ra-pub').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sub = $('ra-submit');
    sub.disabled = true;
    try {
      const v = await api('/chat/api/rooms/owner', { room, owner: ownerB64 });
      // Keep the same owner key when republishing, so pending requests stay readable
      let boxed = v.ownerBox;
      if (!(await ownerKey(v))) {
        const k = await newEcdh();
        ownerPriv = k.priv;
        boxed = b64url(await boxOwnerKey(owner, room, k.priv));
      }
      const pub = rawPublic(await exportEcdh(ownerPriv));
      await api('/chat/api/rooms/publish', { room, owner: ownerB64, name: $('ra-name').value.trim(), desc: $('ra-desc').value.trim(), ownerPub: b64url(pub), ownerBox: boxed });
      await refresh();
    } catch (err) {
      $('ra-state').textContent = err.message;
    } finally {
      sub.disabled = false;
    }
  });

  $('ra-unpub').onclick = async () => {
    if (!confirm('从事件群列表撤下？已经进群的人不受影响。')) return;
    try {
      await api('/chat/api/rooms/unpublish', { room, owner: ownerB64 });
    } catch (err) {
      alert(err.message);
    }
    refresh();
  };

  // New requests show on the button while the room is open
  refresh();
  setInterval(() => (box.hidden ? countOnly() : refresh()), 30_000);
  async function countOnly() {
    try {
      onCount((await api('/chat/api/rooms/owner', { room, owner: ownerB64 })).requests.length);
    } catch {}
  }
}

// P-256 public key (uncompressed, 65 bytes) from a private JWK's x and y
function rawPublic(jwk) {
  const x = fromB64url(jwk.x);
  const y = fromB64url(jwk.y);
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(x, 1 + 32 - x.length);
  out.set(y, 33 + 32 - y.length);
  return out;
}
