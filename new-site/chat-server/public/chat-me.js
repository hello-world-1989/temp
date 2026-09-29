// 我的身份与群: the 保险箱 dialog (set a passphrase, unlock, 我的群, 事件墙 receipts, 恢复口令,
// backup file, move to a new device). All text is set with textContent; the only markup inserted
// is the generated QR SVG.
import qrcode from './qrcode.js';
import { b64url, exportIdentity, fragment, fromB64url, importIdentity, kvClear, kvGet, kvPut, loadIdentity, newIdentity, proofOfWork } from './chat-crypto.js';
import {
  MIN_PASS, backupFile, cleanContents, lockBox, newBox, newRecoveryPhrase, normalizePhrase, openBox, openRecovery,
  openTransfer, parseTransfer, pushRecovery, readBackupFile, recoveryKeys, sealTransfer, sessionKey, setSessionKey,
  transferFragment, unlockBox,
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
  $('me-find-wrap').hidden = !(id === 'me-none' || id === 'me-locked');
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
    // Another page of this site (事件墙) may have added receipts since this one opened the vault
    try {
      const stored = await kvGet('vault');
      if (stored && stored.ct !== vault.box.ct) {
        const other = cleanContents(await unlockBox(vault.raw, stored));
        for (const r of other.receipts) if (!vault.data.receipts.some((x) => x.receipt === r.receipt)) vault.data.receipts.push(r);
        vault.data.receipts.sort((a, b) => b.at - a.at);
      }
    } catch {}
    vault.box = await lockBox(vault.raw, vault.data, vault.box);
    await kvPut('vault', vault.box);
    if (vault.data.recovery) syncSoon();
  }

  // 恢复口令: every change is also sent (encrypted) to the server, a moment after it happens
  let syncTimer = null;
  function syncSoon() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncRecovery().catch((err) => setRecStatus(`同步失败：${err.message}`)), 1500);
  }
  const setRecStatus = (t) => $('me-rec-status') && ($('me-rec-status').textContent = t);
  async function syncRecovery(pow) {
    await pushRecovery(vault.data, pow);
    setRecStatus(`（已同步 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`);
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
    const rl = $('me-receipts');
    rl.replaceChildren();
    $('me-receipts-empty').hidden = vault.data.receipts.length > 0;
    for (const r of vault.data.receipts) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/board-status#${r.receipt}`;
      a.textContent = `${r.kind === 'comment' ? '留言' : '投稿'}：${r.title || '（无标题）'}`;
      const when = document.createElement('span');
      when.className = 'small muted';
      when.textContent = r.at ? ` ${new Date(r.at).toLocaleDateString('zh-CN')}` : '';
      li.append(a, when);
      rl.append(li);
    }
    $('me-rec-off').hidden = !!vault.data.recovery;
    $('me-rec-onbox').hidden = !vault.data.recovery;
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

  $('me-rec-on').onclick = async () => {
    const btn = $('me-rec-on');
    btn.disabled = true;
    try {
      note('正在生成并加密上传，通常几秒钟…');
      const phrase = newRecoveryPhrase();
      vault.data.recovery = { phrase };
      const { challenge, bits } = await api('/chat/api/pow?for=backup');
      await syncRecovery(await proofOfWork(challenge, bits));
      vault.box = await lockBox(vault.raw, vault.data, vault.box);
      await kvPut('vault', vault.box);
      note('');
      renderOpen();
      $('me-rec-phrase').textContent = phrase;
      $('me-rec-box').hidden = false;
    } catch (err) {
      vault.data.recovery = null;
      note(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
  $('me-rec-show').onclick = () => {
    $('me-rec-phrase').textContent = vault.data.recovery?.phrase || '';
    $('me-rec-box').hidden = !$('me-rec-box').hidden;
  };
  $('me-rec-del').onclick = async () => {
    if (!confirm('关闭恢复口令，并删除服务器上的加密备份？之后丢了设备就只能靠备份文件找回。')) return;
    try {
      const k = await recoveryKeys(vault.data.recovery.phrase);
      await api('/chat/api/backup/delete', { id: k.id, write: b64url(k.write) });
      vault.data.recovery = null;
      await save();
      $('me-rec-box').hidden = true;
      renderOpen();
      note('已关闭，服务器上的备份已删除。');
    } catch (err) {
      note(err.message, 'error');
    }
  };

  // Found by a recovery phrase: this device takes it over with its own passphrase
  onSubmit($('me-find'), async () => {
    const phrase = normalizePhrase($('me-f-phrase').value);
    if (!phrase) throw new Error('恢复口令应该是 20 个字母和数字（例如 abcd-efgh-jkmn-pqrs-tuvw），请检查有没有抄错');
    note('正在查找…');
    const k = await recoveryKeys(phrase);
    const { blob } = await api('/chat/api/backup/get', { id: k.id });
    let data;
    try {
      data = cleanContents(await openRecovery(k.aes, fromB64url(blob)));
    } catch {
      throw new Error('备份无法解密：请检查恢复口令');
    }
    note('');
    await receiveContents(data, '已找到');
  });

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

  // Identity and lists from elsewhere (another device, or a recovery phrase): ask for this
  // device's passphrase, then make them this device's vault (the page reloads)
  let incoming = null;
  onSubmit($('me-recv-form'), async () => {
    if (!incoming) return;
    const err = checkPass($('me-t-pass').value, $('me-t-pass2').value);
    if (err) throw new Error(err);
    const hasVault = !!(await kvGet('vault').catch(() => null));
    if (hasVault && !confirm('这台设备上已经保存过身份和群，会被替换。继续？')) return;
    note('正在加密…');
    const { box, raw } = await newBox($('me-t-pass').value, incoming);
    await adopt(box, raw);
  });
  async function receiveContents(data, what) {
    incoming = data;
    pane('me-recv');
    if (!dialog.open) dialog.showModal();
    const extra = [data.rooms.length ? `${data.rooms.length} 个群` : '', data.receipts.length ? `${data.receipts.length} 条事件墙回执` : ''].filter(Boolean).join('、');
    $('me-recv-info').textContent = `${what}：${data.identity ? '身份（指纹不变）' : '（没有身份）'}${extra ? `、${extra}` : ''}。给这台设备设一个口令，以后在这里用它解锁。`;
    $('me-recv-form').hidden = false;
    // Setting the passphrase reloads the page; closing the dialog instead gives up
    await new Promise((r) => dialog.addEventListener('close', r, { once: true }));
    incoming = null;
  }

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
      await receiveContents(data, '已收到');
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
