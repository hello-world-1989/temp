// 加密分享: file format and encryption (Web Crypto, runs only in the browser)
//
// Uploaded blob:  "EGS1" | flags (1 byte, bit 0 = password) | IV (12 bytes) | AES-256-GCM ciphertext
// Plaintext:      header length (uint32 BE) | header JSON { n: name, t: type, d: delete token } | file bytes
// The first 5 bytes are authenticated (AAD), so the password flag cannot be changed.
//
// The link key (32 random bytes) is in the link's #fragment and never reaches the server.
// Without a password:  AES key = SHA-256(linkKey)
// With a password:     AES key = SHA-256(linkKey | PBKDF2-SHA256(password, salt = linkKey, 300000))
// so the password alone is useless, and guessing it needs the link too.

export const MAX_FILE = 50 * 1024 * 1024;
const MAGIC = [0x45, 0x47, 0x53, 0x31]; // "EGS1"
const PBKDF2_ITERATIONS = 300000;
const te = new TextEncoder();

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

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function aesKey(linkKey, password) {
  let material = linkKey;
  if (password) {
    const pw = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: linkKey, iterations: PBKDF2_ITERATIONS }, pw, 256),
    );
    material = new Uint8Array(linkKey.length + bits.length);
    material.set(linkKey);
    material.set(bits, linkKey.length);
  }
  const raw = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// -> { blob, linkKey, deleteToken }
export async function encryptFile(file, password = '') {
  const linkKey = randomBytes(32);
  const deleteToken = b64url(randomBytes(32));
  const header = te.encode(JSON.stringify({ n: file.name || 'file', t: file.type || 'application/octet-stream', d: deleteToken }));
  const data = new Uint8Array(await file.arrayBuffer());
  const plain = new Uint8Array(4 + header.length + data.length);
  new DataView(plain.buffer).setUint32(0, header.length);
  plain.set(header, 4);
  plain.set(data, 4 + header.length);

  const prefix = new Uint8Array([...MAGIC, password ? 1 : 0]);
  const iv = randomBytes(12);
  const key = await aesKey(linkKey, password);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: prefix }, key, plain);
  return { blob: new Blob([prefix, iv, ct], { type: 'application/octet-stream' }), linkKey, deleteToken };
}

export function needsPassword(bytes) {
  return bytes[4] === 1;
}

// -> { name, type, deleteToken, data } ; throws Error('password') when the key/password is wrong
export async function decryptFile(bytes, linkKey, password = '') {
  if (bytes.length < 17 + 16 || !MAGIC.every((b, i) => bytes[i] === b)) throw new Error('format');
  const prefix = bytes.subarray(0, 5);
  const iv = bytes.subarray(5, 17);
  const key = await aesKey(linkKey, needsPassword(bytes) ? password : '');
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: prefix }, key, bytes.subarray(17)));
  } catch {
    throw new Error('password');
  }
  const hlen = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + hlen)));
  return { name: String(header.n || 'file'), type: String(header.t || 'application/octet-stream'), deleteToken: String(header.d || ''), data: plain.subarray(4 + hlen) };
}
