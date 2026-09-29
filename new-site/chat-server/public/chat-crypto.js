// 加密聊天: keys, message format and signatures (Web Crypto, runs only in the browser)
//
// Invite link:  https://<mirror>/chat#<room id>.<room key>          (owner link adds .<owner token>)
// The part after # never reaches any server. From the 32-byte room key (HKDF-SHA256):
//   "msg"   AES-256-GCM key for messages and the room's name
//   "auth"  token the server checks (it stores only its SHA-256), so only key holders get in
//
// Blob:        "EGC1" | IV (12 bytes) | AES-256-GCM ciphertext, AAD = "EGC1" | room id | kind
// Plaintext:   length (uint32 BE) | JSON | zero padding to 256 / 1024 / 4096 / 16384 bytes,
//              so the server cannot tell a short message from a longer one
// Message:     { i: random id, n: nickname, x: text, t: time, k: public key, s: signature }
//              signed with the sender's Ed25519 key (kept in this browser), which shows as a
//              fingerprint next to the nickname: the same nickname with another fingerprint
//              is someone else.

const te = new TextEncoder();
const td = new TextDecoder();
const MAGIC = te.encode('EGC1');
const BUCKETS = [256, 1024, 4096, 16384];
export const MAX_TEXT = 4000;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
export const sha256b64 = async (bytes) => b64url(await sha256(bytes));

export function newRoomId() {
  let out = '';
  while (out.length < 16) for (const b of randomBytes(32)) if (b < 224 && out.length < 16) out += ALPHABET[b % 56];
  return out;
}

// "#room.key[.owner]" -> { room, key, owner } or null
export function parseFragment(hash) {
  const m = /^#?([A-Za-z0-9]{16})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{43}))?$/.exec(hash || '');
  if (!m) return null;
  return { room: m[1], key: fromB64url(m[2]), owner: m[3] ? fromB64url(m[3]) : null };
}

export const fragment = (room, key, owner) => `#${room}.${b64url(key)}${owner ? `.${b64url(owner)}` : ''}`;

// Room key -> { aes, auth (bytes) }
export async function roomKeys(key) {
  const base = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = te.encode('end-gfw-chat v1');
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('msg') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const auth = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('auth') }, base, 256));
  return { aes, auth };
}

function pad(json) {
  const body = te.encode(JSON.stringify(json));
  const size = BUCKETS.find((b) => b >= body.length + 4);
  if (!size) throw new Error('too long');
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  return out;
}

function unpad(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  if (len > bytes.length - 4) throw new Error('format');
  return JSON.parse(td.decode(bytes.subarray(4, 4 + len)));
}

const aad = (room, kind) => new Uint8Array([...MAGIC, ...te.encode(room), ...te.encode(kind)]);

export async function seal(aes, room, kind, json) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(room, kind) }, aes, pad(json)));
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set(MAGIC);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

export async function open(aes, room, kind, blob) {
  if (blob.length < 32 || !MAGIC.every((b, i) => blob[i] === b)) throw new Error('format');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData: aad(room, kind) }, aes, blob.subarray(16));
  return unpad(new Uint8Array(plain));
}

// ---- identity (Ed25519, where the browser has it) ------------------------------------------

const signed = (room, m) => te.encode(JSON.stringify([room, m.i, m.n, m.x, m.t]));

export async function fingerprint(pub) {
  const h = [...(await sha256(pub)).subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

// Without a 保险箱 (chat-vault.js) the key pair lives in IndexedDB as it is; with one it lives
// only inside the vault. It is exportable so that it can be backed up and moved to another
// device. Without IndexedDB it lasts for this page only; without Ed25519 messages go unsigned.
export async function newIdentity() {
  try {
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return identityFrom(keys);
  } catch {
    return null;
  }
}

async function identityFrom(keys) {
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  return { keys, pub, fp: await fingerprint(pub) };
}

export async function loadIdentity() {
  try {
    const keys = await kvGet('identity');
    if (keys) return identityFrom(keys);
  } catch {}
  const id = await newIdentity();
  if (id) {
    try {
      await kvPut('identity', id.keys);
    } catch {}
  }
  return id;
}

// -> { pkcs8, pub } (base64url) ; null when the key cannot be exported (made before backups existed)
export async function exportIdentity(id) {
  if (!id?.keys.privateKey.extractable) return null;
  return { pkcs8: b64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', id.keys.privateKey))), pub: b64url(id.pub) };
}

export async function importIdentity(saved) {
  const privateKey = await crypto.subtle.importKey('pkcs8', fromB64url(saved.pkcs8), { name: 'Ed25519' }, true, ['sign']);
  const publicKey = await crypto.subtle.importKey('raw', fromB64url(saved.pub), { name: 'Ed25519' }, true, ['verify']);
  return identityFrom({ privateKey, publicKey });
}

// ---- storage on this device (IndexedDB key-value) ------------------------------------------

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('end-gfw-chat', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', mode);
      const r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => {
        req.result.close();
        resolve(r.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}
export const kvGet = (name) => idb('readonly', (s) => s.get(name));
export const kvPut = (name, v) => idb('readwrite', (s) => (v == null ? s.delete(name) : s.put(v, name)));
export const kvClear = () => idb('readwrite', (s) => s.clear());

// -> message JSON ready for seal()
export async function makeMessage(room, identity, nick, text) {
  const m = { i: b64url(randomBytes(12)), n: nick, x: text, t: Date.now() };
  if (identity) {
    m.k = b64url(identity.pub);
    m.s = b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.keys.privateKey, signed(room, m))));
  }
  return m;
}

// -> { id, nick, text, time, fp (null: unsigned) } ; throws on a bad signature
export async function checkMessage(room, m) {
  const out = { id: String(m.i || ''), nick: String(m.n || '').slice(0, 40), text: String(m.x || '').slice(0, MAX_TEXT), time: Number(m.t) || 0, fp: null };
  if (m.k && m.s) {
    const pub = fromB64url(m.k);
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify('Ed25519', key, fromB64url(m.s), signed(room, m)))) throw new Error('signature');
    out.fp = await fingerprint(pub);
  }
  return out;
}

// ---- proof of work (room creation only) ----------------------------------------------------

function zeroBits(buf) {
  let n = 0;
  for (const byte of new Uint8Array(buf)) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export async function proofOfWork(challenge, bits, onProgress) {
  const expected = 2 ** bits;
  const batch = 256;
  for (let start = 0; ; start += batch) {
    const nonces = Array.from({ length: batch }, (_, k) => (start + k).toString(36));
    const hashes = await Promise.all(nonces.map((n) => crypto.subtle.digest('SHA-256', te.encode(challenge + n))));
    const hit = hashes.findIndex((h) => zeroBits(h) >= bits);
    if (hit >= 0) return { challenge, nonce: nonces[hit] };
    if (onProgress && start % (batch * 16) === 0) onProgress(Math.min(0.95, start / (expected * 1.5)));
  }
}
