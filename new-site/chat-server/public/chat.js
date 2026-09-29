// 加密聊天 page. Everything readable exists only in this page: the server sees ciphertext,
// the room id and message timings. Text is always shown with textContent, never as HTML.
import qrcode from './qrcode.js';
import {
  MAX_TEXT, b64url, checkMessage, fragment, fromB64url, makeMessage, newRoomId,
  open, parseFragment, proofOfWork, randomBytes, roomKeys, seal, sha256b64,
} from './chat-crypto.js';
import { setupVault } from './chat-me.js';

const $ = (id) => document.getElementById(id);
const TTLS = [
  [300, '5 分钟'],
  [3600, '1 小时'],
  [86400, '1 天'],
  [7 * 86400, '7 天'],
];

function show(view) {
  for (const v of ['v-create', 'v-created', 'v-join', 'v-room']) $(v).hidden = v !== view;
}

function note(el, text, kind = '') {
  el.hidden = !text;
  el.className = `notice ${kind}`.trim();
  el.textContent = text || '';
}

function fillTtl(select, max, selected) {
  select.replaceChildren();
  for (const [s, label] of TTLS) {
    if (s > max) continue;
    const o = new Option(label, String(s));
    if (s === selected) o.selected = true;
    select.append(o);
  }
}

function qr(el, text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); // generated SVG, no user markup
}

async function copy(btn, text) {
  const hint = btn.querySelector('.hint');
  try {
    await navigator.clipboard.writeText(text);
    hint.textContent = '已复制';
  } catch {
    const r = document.createRange();
    r.selectNodeContents(btn.querySelector('code'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    hint.textContent = '请手动复制（已选中）';
  }
  setTimeout(() => (hint.textContent = btn.dataset.hint || '点击复制'), 2500);
}

const linkFor = (room, key, owner) => `${location.origin}/chat${fragment(room, key, owner)}`;

// Other addresses of 加密聊天 (the site, its mirror nodes, the :8443 relays): invite links carry
// them as backup lines, so a blocked address does not lock people out of a room
const entriesReady = fetch('/chat/api/entries', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => (Array.isArray(d.entries) ? d.entries : []))
  .catch(() => []);

// Shows `frag` as a link on this address plus its backups; the copy button copies all of them
async function showLink(codeId, btnId, backupsId, frag) {
  const main = `${location.origin}/chat${frag}`;
  $(codeId).textContent = main;
  const others = [];
  for (const e of await entriesReady) {
    let u;
    try {
      u = new URL(String(e.url));
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.origin === location.origin || u.pathname !== '/chat') continue;
    others.push({ url: `${u.origin}/chat${frag}`, label: String(e.label || '').slice(0, 30) });
  }
  const box = $(backupsId);
  const ul = box.querySelector('ul');
  ul.replaceChildren();
  for (const o of others) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = o.label;
    li.append(label, o.url);
    ul.append(li);
  }
  box.hidden = !others.length;
  const text = others.length ? `${main}\n\n打不开时用备用地址（同一个群）：\n${others.map((o) => o.url).join('\n')}` : main;
  const btn = $(btnId);
  btn.dataset.hint = others.length ? `点击复制（含 ${others.length} 个备用地址）` : '点击复制';
  btn.querySelector('.hint').textContent = btn.dataset.hint;
  btn.onclick = () => copy(btn, text);
  return main;
}

function left(ms) {
  if (ms <= 0) return '即将删除';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} 秒后删除`;
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后删除`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时后删除`;
  return `${Math.round(s / 86400)} 天后删除`;
}

const hhmm = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// ---- 建群 ---------------------------------------------------------------------------------

function createView() {
  show('v-create');
  fillTtl($('c-ttl'), 7 * 86400, 86400);
  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('c-submit');
    btn.disabled = true;
    try {
      note($('c-msg'), '正在做一个小计算防止滥用，通常几秒钟…');
      const { challenge, bits } = await api('GET', '/chat/api/pow');
      const pow = await proofOfWork(challenge, bits, (p) => note($('c-msg'), `正在做一个小计算防止滥用… ${Math.round(p * 100)}%`));
      const room = newRoomId();
      const key = randomBytes(32);
      const owner = randomBytes(32);
      const { aes, auth } = await roomKeys(key);
      const meta = await seal(aes, room, 'meta', { name: $('c-name').value.trim().slice(0, 40), ttl: Number($('c-ttl').value) });
      await api('POST', '/chat/api/rooms', { id: room, auth: await sha256b64(auth), owner: await sha256b64(owner), meta: b64url(meta), pow });
      const invite = await showLink('invite', 'invite-copy', 'invite-backups', fragment(room, key));
      const admin = await showLink('owner', 'owner-copy', 'owner-backups', fragment(room, key, owner));
      qr($('invite-qr'), invite);
      $('enter').href = admin;
      $('enter').onclick = (ev) => {
        ev.preventDefault();
        location.hash = fragment(room, key, owner);
      };
      show('v-created');
    } catch (err) {
      note($('c-msg'), err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ---- 群聊 ---------------------------------------------------------------------------------

async function roomView(frag, identity, vault) {
  const { room, key, owner } = frag;
  const { aes, auth } = await roomKeys(key);
  const invite = linkFor(room, key);
  let nick = vault.nick;

  show('v-join');
  $('j-nick').value = nick;
  $('j-nick').focus();
  await new Promise((resolve) =>
    $('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      nick = $('j-nick').value.trim().slice(0, 20);
      if (!nick) return $('j-nick').focus();
      vault.setNick(nick).catch(() => {});
      resolve();
    }),
  );

  show('v-room');
  $('r-destroy').hidden = !owner;
  showLink('r-invite-link', 'r-invite-copy', 'r-invite-backups', fragment(room, key));
  $('r-invite').onclick = () => {
    const box = $('r-invite-box');
    box.hidden = !box.hidden;
    if (!box.hidden && !$('r-invite-qr').firstChild) qr($('r-invite-qr'), invite);
  };

  const msgs = new Map(); // id -> { li, exp, burn, mine, info }
  const decoded = new Map(); // ciphertext -> decoded message (so reconnects do not decrypt again)
  const fpsByNick = new Map(); // nickname -> Set of fingerprints seen
  const pending = new Map(); // ref -> delete token
  const deleteTokens = new Map(); // message id -> delete token (this page only)
  const myIds = new Set(); // random ids of messages sent from this page
  const unread = new Set(); // burn messages shown while the page was hidden
  let ws = null;
  let ref = 0;
  let retry = 0;
  let serverSkew = 0; // server clock minus ours
  let gone = false;
  let maxTtl = 7 * 86400;
  let defaultTtl = 86400;

  const list = $('msgs');
  const nowServer = () => Date.now() + serverSkew;
  const status = (text) => ($('r-status').textContent = text);

  // Transport: a WebSocket, or long polling where WebSockets do not get through (some mirrors
  // and networks). Both carry the same messages (see chat-server/src/app.js).
  let mode = 'ws';
  let wsWorked = false;
  let cid = null; // long-poll client id
  const connected = () => (mode === 'ws' ? ws?.readyState === 1 : !!cid);

  function sendJson(obj) {
    if (mode === 'ws') {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      return;
    }
    if (!cid) return;
    postJson('/chat/api/poll/act', { ...obj, cid })
      .then((r) => r.events.forEach(receive))
      .catch(() => {});
  }

  async function postJson(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status, code: data.code });
    return data;
  }

  // Events are handled one at a time, in order
  let inbox = Promise.resolve();
  const receive = (m) => (inbox = inbox.then(() => handle(m)).catch((err) => console.error(err)));

  function remove(id) {
    const m = msgs.get(id);
    if (!m) return;
    m.li.remove();
    msgs.delete(id);
    unread.delete(id);
  }

  function markClash(nickName) {
    const fps = fpsByNick.get(nickName);
    if (!fps || fps.size < 2) return;
    for (const m of msgs.values()) if (m.info?.nick === nickName) m.fpEl?.classList.add('clash');
  }

  async function decode(ct) {
    if (decoded.has(ct)) return decoded.get(ct);
    let info;
    try {
      info = await checkMessage(room, await open(aes, room, 'msg', fromB64url(ct)));
    } catch {
      info = null; // wrong key or forged: shown as unreadable
    }
    decoded.set(ct, info);
    return info;
  }

  async function add(row, ownRef) {
    if (msgs.has(row.id) || row.exp <= nowServer()) return;
    const info = await decode(row.ct);
    if (msgs.has(row.id)) return;
    const mine = !!info && myIds.has(info.id);
    const li = document.createElement('li');
    li.className = `msg${mine ? ' mine' : ''}${info ? '' : ' bad'}`;
    const head = document.createElement('div');
    head.className = 'msg-head';
    const text = document.createElement('div');
    text.className = 'msg-text';
    const foot = document.createElement('div');
    foot.className = 'msg-foot';
    const time = document.createElement('span');
    const timer = document.createElement('span');
    foot.append(time, timer);
    let fpEl = null;
    if (info) {
      const n = document.createElement('span');
      n.className = 'nick';
      n.textContent = info.nick || '（无名）';
      fpEl = document.createElement('span');
      fpEl.className = 'fp';
      fpEl.textContent = info.fp ? `#${info.fp}` : '未签名';
      fpEl.title = '指纹：同一个昵称指纹不一样就不是同一个人';
      head.append(n, fpEl);
      text.textContent = info.text;
      if (info.fp) {
        const set = fpsByNick.get(info.nick) || new Set();
        set.add(info.fp);
        fpsByNick.set(info.nick, set);
      }
    } else {
      text.textContent = '（无法解密的消息：可能被篡改，已忽略）';
    }
    time.textContent = hhmm(row.ts - serverSkew);
    if (ownRef != null && pending.has(ownRef)) {
      deleteTokens.set(row.id, pending.get(ownRef));
      pending.delete(ownRef);
    }
    if (deleteTokens.has(row.id)) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkish';
      del.textContent = '撤回';
      del.onclick = () => sendJson({ t: 'del', id: row.id, token: b64url(deleteTokens.get(row.id)) });
      foot.append(del);
    }
    li.append(head, text, foot);
    const m = { li, exp: row.exp, burn: row.burn, mine, info, fpEl, timer, id: row.id };
    msgs.set(row.id, m);
    // Keep the list in id order
    const after = [...list.children].find((el) => Number(el.dataset.id) > row.id);
    li.dataset.id = String(row.id);
    list.insertBefore(li, after || null);
    if (info) markClash(info.nick);
    tick(m);
    if (row.burn && !mine && info) {
      unread.add(row.id);
      flushRead();
    }
  }

  // 阅后即焚: tell the server once the message has been on a visible screen
  function flushRead() {
    if (document.visibilityState !== 'visible' || !unread.size) return;
    sendJson({ t: 'read', ids: [...unread] });
    unread.clear();
  }
  document.addEventListener('visibilitychange', flushRead);

  function tick(m) {
    const ms = m.exp - nowServer();
    if (ms <= 0) return remove(m.id);
    m.timer.textContent = m.burn ? `${left(ms)} · 阅后即焚` : left(ms);
    m.timer.className = ms < 120_000 ? 'burning' : '';
  }
  setInterval(() => {
    for (const m of [...msgs.values()]) tick(m);
  }, 1000);

  function reconnectLater() {
    if (gone) return;
    retry = Math.min(retry + 1, 6);
    const wait = Math.min(30, 2 ** retry) * 1000;
    status(`连接断开，${Math.round(wait / 1000)} 秒后重连…`);
    setTimeout(connect, wait);
  }

  function connect() {
    if (gone) return;
    status('连接中…');
    if (mode === 'poll') return pollLoop();
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', room, token: b64url(auth) }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'ready') wsWorked = true;
      receive(m);
    };
    ws.onclose = () => {
      if (gone) return;
      if (!wsWorked) {
        // Never got through: this network or mirror does not pass WebSockets
        mode = 'poll';
        return connect();
      }
      reconnectLater();
    };
  }

  async function pollLoop() {
    try {
      const r = await postJson('/chat/api/poll/join', { room, token: b64url(auth) });
      cid = r.cid;
      receive(r.ready);
    } catch (err) {
      if (err.code === 'room' || err.code === 'full') return receive({ t: 'error', code: err.code, message: err.message });
      return reconnectLater();
    }
    while (!gone) {
      let r;
      try {
        r = await postJson('/chat/api/poll', { cid });
      } catch (err) {
        cid = null;
        if (err.status === 404) return connect(); // dropped by the server: join again
        return reconnectLater();
      }
      for (const m of r.events) receive(m);
    }
  }

  async function handle(m) {
    if (m.t === 'ready') {
      retry = 0;
      serverSkew = m.now - Date.now();
      maxTtl = m.maxTtl;
      try {
        const meta = await open(aes, room, 'meta', fromB64url(m.meta));
        if (meta.name) {
          $('r-name').textContent = meta.name;
          document.title = `${meta.name} · 加密聊天`;
        }
        if (Number.isInteger(meta.ttl)) defaultTtl = meta.ttl;
        // 我的群: saved (encrypted) when this device has a 保险箱 open
        vault.remember({ room, key, owner, name: String(meta.name || '').slice(0, 40) }).catch(() => {});
      } catch {
        note($('r-msg'), '群信息无法解密：链接可能不完整。', 'error');
      }
      if (!$('s-ttl').options.length) fillTtl($('s-ttl'), maxTtl, defaultTtl);
      // The server's list is the truth: drop what was deleted while we were away
      const ids = new Set(m.msgs.map((r) => r.id));
      for (const id of [...msgs.keys()]) if (!ids.has(id)) remove(id);
      for (const r of m.msgs) await add(r);
      $('r-online').textContent = m.online;
      status(mode === 'ws' ? '已连接（端到端加密）' : '已连接（端到端加密，兼容模式）');
      note($('r-msg'), '');
      list.lastElementChild?.scrollIntoView({ block: 'end' });
    } else if (m.t === 'msg') {
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      await add(m, m.ref);
      if (atBottom || m.ref != null) list.lastElementChild?.scrollIntoView({ block: 'end' });
    } else if (m.t === 'exp') {
      const x = msgs.get(m.id);
      if (x) {
        x.exp = m.exp;
        tick(x);
      }
    } else if (m.t === 'del') {
      remove(m.id);
    } else if (m.t === 'online') {
      $('r-online').textContent = m.n;
    } else if (m.t === 'gone') {
      gone = true;
      for (const id of [...msgs.keys()]) remove(id);
      note($('r-msg'), '这个群已经被销毁，所有消息都已删除。', 'warn');
      $('send-form').hidden = true;
      status('已销毁');
    } else if (m.t === 'error') {
      if (m.code === 'room') {
        gone = true;
        $('send-form').hidden = true;
        status('无法进入');
      }
      note($('r-msg'), m.message, 'error');
    }
  }

  $('send-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('s-text').value.trim();
    if (!text) return;
    if (text.length > MAX_TEXT) return note($('r-msg'), `一条消息最多 ${MAX_TEXT} 个字`, 'error');
    if (!connected()) return note($('r-msg'), '还没连上服务器，请稍等', 'error');
    const msg = await makeMessage(room, identity, nick, text);
    myIds.add(msg.i);
    const token = randomBytes(32);
    const r = ++ref;
    pending.set(r, token);
    const ct = await seal(aes, room, 'msg', msg);
    sendJson({ t: 'send', ref: r, ct: b64url(ct), ttl: Number($('s-ttl').value) || defaultTtl, burn: Number($('s-burn').value) || 0, dh: await sha256b64(token) });
    $('s-text').value = '';
    $('s-text').focus();
  });
  $('s-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('send-form').requestSubmit();
    }
  });

  $('r-destroy').onclick = () => {
    if (!confirm('销毁后群和所有消息都会立刻删除，所有人都会被移出，不能恢复。确定销毁？')) return;
    sendJson({ t: 'destroy', owner: b64url(owner) });
  };

  connect();
}

// ---- start --------------------------------------------------------------------------------

// Official addresses: the relays on :8443 (TLS ends on the chat server itself), this site's
// domains, and its own node IPs (listed by the website at /api/official-hosts). Anywhere else
// (a mirror anyone can run with mirror.sh) the page still works, with a warning: whoever runs
// that mirror could change this page and read the keys in the links.
const OFFICIAL_HOSTS = ['end-gfw.com', 'www.end-gfw.com', 'v2.end-gfw.com', 'localhost', '127.0.0.1'];
async function officialAddress() {
  if (location.port === '8443' || OFFICIAL_HOSTS.includes(location.hostname)) return true;
  try {
    const res = await fetch('/api/official-hosts', { cache: 'no-store' });
    if (!res.ok) return false;
    return ((await res.json()).hosts || []).includes(location.hostname);
  } catch {
    return false;
  }
}

async function main() {
  if (!window.crypto?.subtle || !window.WebSocket) {
    $('unsupported').hidden = false;
    return;
  }
  if (!(await officialAddress())) $('unofficial').hidden = false;
  const { identity, vault } = await setupVault();
  $('me-btn').onclick = () => vault.open();
  const tmp = vault.state === 'skipped' ? '（临时）' : '';
  $('me-fp-top').textContent = identity ? `#${identity.fp}${tmp}` : '不支持签名';
  const frag = parseFragment(location.hash);
  window.addEventListener('hashchange', () => location.reload());
  if (frag) {
    vault.current = { room: frag.room, key: frag.key, owner: frag.owner, name: '' };
    return roomView(frag, identity, vault);
  }
  createView();
  if (location.hash) note($('c-msg'), '链接不完整：请让对方重新发送完整的链接（复制时不要截断）。', 'error');
}

main().catch((err) => {
  console.error(err);
  $('unsupported').hidden = false;
  $('unsupported').textContent = `页面出错：${err.message}`;
});
