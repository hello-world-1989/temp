// 我的身份与群: the 保险箱 dialog (set a passphrase, unlock, 我的群, backup file, move to a new
// device). All text is set with textContent; the only markup inserted is the generated QR SVG.
import qrcode from './qrcode.js';
import { b64url, exportIdentity, fragment, fromB64url, importIdentity, kvClear, kvGet, kvPut, loadIdentity, newIdentity, proofOfWork } from './chat-crypto.js';
import {
  MIN_PASS, backupFile, cleanContents, lockBox, newBox, openBox, openTransfer, parseTransfer, readBackupFile,
  sealTransfer, sessionKey, setSessionKey, transferFragment, unlockBox,
} from './chat-vault.js';

const $ = (id) => document.getElementById(id);
const NICK_KEY = 'chat-nick';
const PANES = ['me-none', 'me-locked', 'me-open', 'me-recv'];

function note(text, kind = '') {
  const el = $('me-msg');
  el.hidden = !text;
  el.className = `notice ${kind}`.trim();
  el.textContent = text || '';
}

function pane(id) {
  for (const p of PANES) $(p).hidden = p !== id;
}

function checkPass(a, b) {
  if (a.length < MIN_PASS) return `口令至少 ${MIN_PASS} 个字符，越长越安全`;
  if (a !== b) return '两次输入的口令不一样';
  return '';
}

const localNick = () => {
  try {
    return localStorage.getItem(NICK_KEY) || '';
  } catch {
    return '';
  }
};

async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// Wraps a form submit handler: button disabled while it runs, errors shown in the dialog
function onSubmit(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      note('');
      await fn();
    } catch (err) {
      note(err.message === 'password' ? '口令不对' : err.message === 'format' ? '不是这个页面导出的备份文件' : err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// -> { identity, vault } ; waits for the person when the vault is locked or a transfer arrives
export async function setupVault() {
  const dialog = $('me');
  const vault = {
    state: 'none', // none | locked | open | skipped
    data: null,
    box: null,
    raw: null,
    current: null, // the room open in this page, added to 我的群 once the vault is open
    get nick() {
      return this.state === 'open' ? this.data.nick : localNick();
    },
    async setNick(nick) {
      if (this.state === 'open') {
        this.data.nick = nick;
        await save();
      } else {
        try {
          localStorage.setItem(NICK_KEY, nick);
        } catch {}
      }
    },
    async remember(entry) {
      this.current = entry;
      if (this.state !== 'open') return;
      const r = { room: entry.room, key: b64url(entry.key), owner: entry.owner ? b64url(entry.owner) : null, name: entry.name || '' };
      const old = this.data.rooms.find((x) => x.room === r.room);
      if (old) {
        if (old.name === r.name && (old.owner || !r.owner)) return;
        old.name = r.name || old.name;
        old.owner = old.owner || r.owner;
      } else {
        this.data.rooms.unshift({ ...r, added: Date.now() });
      }
      await save();
    },
    open: () => show(),
  };

  async function save() {
    vault.box = await lockBox(vault.raw, vault.data, vault.box);
    await kvPut('vault', vault.box);
  }

  // Makes `data` this device's vault under `raw`, then reloads so everything uses it
  async function adopt(box, raw) {
    await kvPut('vault', box);
    await kvPut('identity', null); // the identity now lives only inside the vault
    try {
      localStorage.removeItem(NICK_KEY);
    } catch {}
    setSessionKey(raw);
    location.reload();
    await new Promise(() => {}); // the page is going away
  }

  function show() {
    note('');
    pane({ none: 'me-none', locked: 'me-locked', skipped: 'me-locked', open: 'me-open' }[vault.state]);
    if (vault.state === 'open') renderOpen();
    if (!dialog.open) dialog.showModal();
  }

  function renderOpen() {
    $('me-fp').textContent = identity ? `#${identity.fp}` : '（这个浏览器不支持签名）';
    const list = $('me-rooms');
    list.replaceChildren();
    $('me-rooms-empty').hidden = vault.data.rooms.length > 0;
    for (const r of vault.data.rooms) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/chat${fragment(r.room, fromB64url(r.key), r.owner ? fromB64url(r.owner) : null)}`;
      a.textContent = r.name || `未命名群 ${r.room.slice(0, 4)}`;
      a.addEventListener('click', () => dialog.close());
      li.append(a);
      if (r.owner) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '群主';
        li.append(' ', tag);
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkish small';
      del.textContent = '移除';
      del.onclick = async () => {
        if (!confirm('从我的群里移除？（群本身不受影响，有邀请链接还能再进）')) return;
        vault.data.rooms = vault.data.rooms.filter((x) => x.room !== r.room);
        await save();
        renderOpen();
      };
      li.append(' ', del);
      list.append(li);
    }
  }

  let unlocked;
  const unlockWait = new Promise((r) => (unlocked = r));

  // ---- wiring ------------------------------------------------------------------------------
  $('me-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => unlocked(null)); // closing the unlock prompt = 暂不解锁

  onSubmit($('me-create'), async () => {
    const err = checkPass($('me-c-pass').value, $('me-c-pass2').value);
    if (err) throw new Error(err);
    let saved = await exportIdentity(identity);
    if (!saved && identity) {
      // made before backups existed: this browser gets a new, exportable key (new fingerprint)
      if (!confirm('这个浏览器原来的身份密钥不能导出，需要换一个新的，指纹会变。群友会看到你的指纹变了。继续？')) return;
      saved = await exportIdentity(await newIdentity());
    }
    const data = { identity: saved, nick: localNick(), rooms: [] };
    if (vault.current) data.rooms.push({ room: vault.current.room, key: b64url(vault.current.key), owner: vault.current.owner ? b64url(vault.current.owner) : null, name: vault.current.name || '', added: Date.now() });
    note('正在加密…');
    const { box, raw } = await newBox($('me-c-pass').value, data);
    await adopt(box, raw);
  });

  onSubmit($('me-restore'), async () => {
    const file = $('me-r-file').files[0];
    if (!file) throw new Error('请选择备份文件');
    const box = readBackupFile(await file.text());
    note('正在解密…');
    const { data, raw } = await openBox($('me-r-pass').value, box);
    cleanContents(data);
    await adopt(box, raw);
  });

  onSubmit($('me-unlock'), async () => {
    note('正在解锁…');
    const { data, raw } = await openBox($('me-u-pass').value, vault.box);
    setSessionKey(raw);
    if (vault.state === 'skipped') {
      location.reload(); // switch this page from the temporary identity to the saved one
      return;
    }
    unlocked({ data: cleanContents(data), raw });
    dialog.close();
  });
  $('me-skip').onclick = () => {
    unlocked(null);
    dialog.close();
  };

  for (const id of ['me-wipe', 'me-wipe2']) {
    $(id).onclick = async () => {
      if (!confirm('删除这个浏览器里保存的身份、昵称和群列表？删除后不能恢复（除非你有备份文件）。群本身不受影响。')) return;
      try {
        await kvClear();
      } catch {}
      try {
        localStorage.removeItem(NICK_KEY);
      } catch {}
      setSessionKey(null);
      location.href = '/chat';
    };
  }

  $('me-lock').onclick = () => {
    setSessionKey(null);
    location.reload();
  };

  $('me-export').onclick = () => {
    const blob = new Blob([backupFile(vault.box)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `end-gfw-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    note('备份文件已下载。它用你的口令加密，没有口令打不开；忘了口令也打不开。', '');
  };

  let xferTimer = null;
  $('me-move').onclick = async () => {
    const btn = $('me-move');
    btn.disabled = true;
    try {
      note('正在准备，通常几秒钟…');
      const { challenge, bits } = await api('/chat/api/pow?for=transfer');
      const pow = await proofOfWork(challenge, bits);
      const { key, blob } = await sealTransfer(vault.data);
      const { id, exp } = await api('/chat/api/transfer', { blob: b64url(blob), pow });
      const link = `${location.origin}/chat${transferFragment(id, key)}`;
      const q = qrcode(0, 'L');
      q.addData(link);
      q.make();
      $('me-x-qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); // generated SVG
      $('me-x-link').textContent = link;
      $('me-xfer').hidden = false;
      note('');
      clearInterval(xferTimer);
      const tick = () => {
        const s = Math.max(0, Math.round((exp - Date.now()) / 1000));
        $('me-x-left').textContent = s ? `${Math.floor(s / 60)} 分 ${s % 60} 秒内有效` : '已过期，请重新生成';
        if (!s) {
          clearInterval(xferTimer);
          $('me-x-qr').replaceChildren();
          $('me-x-link').textContent = '';
        }
      };
      tick();
      xferTimer = setInterval(tick, 1000);
    } catch (err) {
      note(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
  $('me-x-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('me-x-link').textContent);
      $('me-x-copy').querySelector('.hint').textContent = '已复制';
    } catch {}
  };

  // ---- start -----------------------------------------------------------------------------
  let identity = null;

  // Arriving from another device's QR code
  const xfer = parseTransfer(location.hash);
  if (xfer) {
    history.replaceState(null, '', '/chat');
    pane('me-recv');
    dialog.showModal();
    note('正在从旧设备接收…');
    try {
      const { blob } = await api('/chat/api/transfer/take', { id: xfer.id });
      const data = cleanContents(await openTransfer(xfer.key, fromB64url(blob)));
      note('');
      $('me-recv-info').textContent = `已收到：${data.identity ? '身份（指纹不变）' : '（没有身份）'}、${data.rooms.length} 个群。给这台设备设一个口令，以后在这里用它解锁。`;
      $('me-recv-form').hidden = false;
      const hasVault = !!(await kvGet('vault').catch(() => null));
      await new Promise((resolve) =>
        onSubmit($('me-recv-form'), async () => {
          const err = checkPass($('me-t-pass').value, $('me-t-pass2').value);
          if (err) throw new Error(err);
          if (hasVault && !confirm('这台设备上已经保存过身份和群，会被旧设备的替换。继续？')) return;
          note('正在加密…');
          const { box, raw } = await newBox($('me-t-pass').value, data);
          resolve();
          await adopt(box, raw);
        }),
      );
    } catch (err) {
      note(err.message, 'error');
      $('me-recv-form').hidden = true;
      await new Promise((r) => dialog.addEventListener('close', r, { once: true }));
    }
  }

  vault.box = await kvGet('vault').catch(() => null);
  if (vault.box) {
    let opened = null;
    const raw = sessionKey();
    if (raw) {
      try {
        opened = { data: cleanContents(await unlockBox(raw, vault.box)), raw };
      } catch {
        setSessionKey(null);
      }
    }
    if (!opened) {
      vault.state = 'locked';
      show();
      opened = await unlockWait;
    }
    if (opened) {
      Object.assign(vault, { state: 'open', data: opened.data, raw: opened.raw });
      identity = opened.data.identity ? await importIdentity(opened.data.identity).catch(() => null) : null;
    } else {
      vault.state = 'skipped';
      identity = await newIdentity(); // this page only
    }
  } else {
    identity = await loadIdentity();
  }
  return { identity, vault };
}
