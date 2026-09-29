// 保险箱: this device's identity key, nickname and 我的群 list, encrypted with a passphrase.
// Nothing here ever reaches the server except a one-time, separately encrypted copy for moving
// to another device (迁移到新设备).
//
// Box (stored in IndexedDB, and as-is in a backup file):
//   { v: 1, kdf: "PBKDF2-SHA256", iter, salt, iv, ct }   base64url; AAD = "EGV1"
//   AES-256-GCM key = PBKDF2-SHA256(passphrase NFKC, salt 16 bytes, 600000)
// Contents:
//   { identity: { pkcs8, pub } | null, nick, rooms: [{ room, key, owner, name, added }] }
// The derived key (not the passphrase) is kept in sessionStorage so reloads in the same tab
// stay unlocked; closing the tab locks it.
//
// Transfer blob (uploaded once, deleted on first download, 10 minutes at most):
//   "EGT1" | IV (12) | AES-256-GCM(contents JSON), AAD = "EGT1", key = 32 random bytes that
//   travel only in the QR code's link fragment: /chat#t.<transfer id>.<key>
import { b64url, fromB64url, randomBytes } from './chat-crypto.js';

export const VAULT_ITER = 600000;
export const MIN_PASS = 8;
const te = new TextEncoder();
const td = new TextDecoder();
const VAULT_AAD = te.encode('EGV1');
const TRANSFER_MAGIC = te.encode('EGT1');

async function passKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256));
}

const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// raw key + contents -> box (salt/iter kept from `like` so the same passphrase still opens it)
export async function lockBox(raw, data, like) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: VAULT_AAD }, await aesKey(raw), te.encode(JSON.stringify(data))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: like.iter, salt: like.salt, iv: b64url(iv), ct: b64url(ct) };
}

// -> contents ; throws Error('password') when the key is wrong
export async function unlockBox(raw, box) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(box.iv), additionalData: VAULT_AAD }, await aesKey(raw), fromB64url(box.ct));
    return JSON.parse(td.decode(plain));
  } catch {
    throw new Error('password');
  }
}

export function isBox(box) {
  return !!box && box.v === 1 && box.kdf === 'PBKDF2-SHA256' && Number.isInteger(box.iter) && box.iter >= 100000 && box.iter <= 10_000_000 &&
    typeof box.salt === 'string' && typeof box.iv === 'string' && typeof box.ct === 'string';
}

// -> { box, raw }
export async function newBox(pass, data, iter = VAULT_ITER) {
  const salt = randomBytes(16);
  const raw = await passKey(pass, salt, iter);
  return { box: await lockBox(raw, data, { iter, salt: b64url(salt) }), raw };
}

// -> { data, raw } ; throws Error('password')
export async function openBox(pass, box) {
  if (!isBox(box)) throw new Error('format');
  const raw = await passKey(pass, fromB64url(box.salt), box.iter);
  return { data: await unlockBox(raw, box), raw };
}

export function cleanContents(data) {
  const rooms = [];
  for (const r of Array.isArray(data?.rooms) ? data.rooms : []) {
    if (!/^[A-Za-z0-9]{16}$/.test(r?.room) || !/^[A-Za-z0-9_-]{43}$/.test(r?.key)) continue;
    if (rooms.some((x) => x.room === r.room)) continue;
    rooms.push({
      room: r.room,
      key: r.key,
      owner: /^[A-Za-z0-9_-]{43}$/.test(r.owner || '') ? r.owner : null,
      name: String(r.name || '').slice(0, 40),
      added: Number(r.added) || 0,
    });
  }
  const id = data?.identity;
  return {
    identity: id && typeof id.pkcs8 === 'string' && typeof id.pub === 'string' ? { pkcs8: id.pkcs8, pub: id.pub } : null,
    nick: String(data?.nick || '').slice(0, 20),
    rooms: rooms.slice(0, 500),
  };
}

// ---- backup file -----------------------------------------------------------------------------

export const backupFile = (box) => JSON.stringify({ type: 'end-gfw-chat-backup', ...box }, null, 1);

export function readBackupFile(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {}
  if (v?.type !== 'end-gfw-chat-backup' || !isBox(v)) throw new Error('format');
  const { type, ...box } = v;
  return box;
}

// ---- moving to another device ----------------------------------------------------------------

export async function sealTransfer(data) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: TRANSFER_MAGIC }, await aesKey(key), te.encode(JSON.stringify(data))));
  const blob = new Uint8Array(4 + 12 + ct.length);
  blob.set(TRANSFER_MAGIC);
  blob.set(iv, 4);
  blob.set(ct, 16);
  return { key, blob };
}

export async function openTransfer(key, blob) {
  if (blob.length < 32 || !TRANSFER_MAGIC.every((b, i) => blob[i] === b)) throw new Error('format');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData: TRANSFER_MAGIC }, await aesKey(key), blob.subarray(16));
  return JSON.parse(td.decode(plain));
}

// "#t.<id>.<key>" -> { id, key } or null
export function parseTransfer(hash) {
  const m = /^#?t\.([A-Za-z0-9]{16})\.([A-Za-z0-9_-]{43})$/.exec(hash || '');
  return m ? { id: m[1], key: fromB64url(m[2]) } : null;
}

export const transferFragment = (id, key) => `#t.${id}.${b64url(key)}`;

// ---- the unlocked key in this tab ------------------------------------------------------------

const SESSION = 'chat-vault-key';
export function sessionKey() {
  try {
    const v = sessionStorage.getItem(SESSION);
    return v ? fromB64url(v) : null;
  } catch {
    return null;
  }
}
export function setSessionKey(raw) {
  try {
    if (raw) sessionStorage.setItem(SESSION, b64url(raw));
    else sessionStorage.removeItem(SESSION);
  } catch {}
}
