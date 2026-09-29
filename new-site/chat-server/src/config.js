// Settings from the environment. The only secret-ish input is the admins credential (hashes of
// the site admins' tokens); the proof-of-work key is random per start, rooms authenticate with a
// hash of a key derived in the browser, and TLS keys are issued on this machine by acme.sh.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// systemd credential ($CREDENTIALS_DIRECTORY/<name>), else the env variable
function cred(env, name) {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (dir) {
    try {
      return readFileSync(join(dir, name), 'utf8').trim();
    } catch {}
  }
  return (env[name.toUpperCase()] || '').trim();
}

// "name:sha256(token)" per line or comma-separated (the same file as 事件墙's admins)
export function parseAdmins(text) {
  const out = new Map();
  for (const line of String(text || '').split(/[\n,]/)) {
    const [name, hash] = line.trim().split(':');
    if (name && /^[0-9a-f]{64}$/.test(hash || '')) out.set(hash, name);
  }
  return out;
}

const int = (env, name, def) => {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
};

// "host:port", or empty to turn that listener off
const addr = (env, name, def) => {
  const v = (env[name] ?? def).trim();
  if (!v) return null;
  const i = v.lastIndexOf(':');
  return { host: v.slice(0, i) || '0.0.0.0', port: Number(v.slice(i + 1)) };
};

export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || './data';
  return {
    // TLS from the mirrors (TCP relay, optional PROXY protocol header). The only public entry.
    listenTls: addr(env, 'LISTEN_TLS', '0.0.0.0:8443'),
    // Plain HTTP from the mirrors' port 80: ACME http-01 answers and the mirrors' check-in
    listenAcme: addr(env, 'LISTEN_ACME', '0.0.0.0:8080'),
    // Plain HTTP for local development and health checks only (never exposed)
    listenHttp: addr(env, 'LISTEN_HTTP', '127.0.0.1:8792'),
    dataDir,
    dbFile: env.DB_FILE || `${dataDir}/chat.db`,
    certDir: env.CERT_DIR || `${dataDir}/certs`,
    webroot: env.WEBROOT || `${dataDir}/webroot`,
    acmeSh: env.ACME_SH || '', // path to acme.sh; empty: no certificates are issued
    acmeHome: env.ACME_HOME || `${dataDir}/acme`,
    // Optional: only these source addresses may connect to the TLS / ACME ports (comma-separated)
    allowFrom: new Set((env.ALLOW_FROM || '').split(',').map((s) => s.trim()).filter(Boolean)),
    // New certificates per hour (Let's Encrypt limits are per IP, this protects the account)
    issuePerHour: int(env, 'ISSUE_PER_HOUR', 10),
    // A mirror that has not checked in or carried a connection for this long loses its certificate
    mirrorDays: int(env, 'MIRROR_DAYS', 7),

    // Site admins (事件墙's admins credential): review which rooms appear in the public list
    admins: parseAdmins(cred(env, 'admins')),
    // The website, where the list of chat addresses for invite links comes from ('' = none)
    siteUrl: (env.SITE_URL ?? 'https://end-gfw.com').trim(),
    powBits: int(env, 'POW_BITS_CREATE', 18),
    powBitsTransfer: int(env, 'POW_BITS_TRANSFER', 15),
    powBitsBackup: int(env, 'POW_BITS_BACKUP', 16),
    powBitsJoin: int(env, 'POW_BITS_JOIN', 16),
    maxBackups: int(env, 'MAX_BACKUPS', 50000),
    backupBytes: int(env, 'BACKUP_BYTES', 256 * 1024),
    maxTransfers: int(env, 'MAX_TRANSFERS', 2000),
    transferBytes: int(env, 'TRANSFER_BYTES', 128 * 1024),
    maxRooms: int(env, 'MAX_ROOMS', 20000),
    // Rooms with no message for this long are deleted with everything in them
    roomIdleDays: int(env, 'ROOM_IDLE_DAYS', 30),
    // Longest a message may live, whatever the sender picked
    maxTtl: int(env, 'MAX_TTL_SECONDS', 7 * 86400),
    maxMessageBytes: int(env, 'MAX_MESSAGE_BYTES', 16 * 1024 + 64),
    maxHistory: int(env, 'MAX_HISTORY', 500),
    maxRoomMessages: int(env, 'MAX_ROOM_MESSAGES', 5000),
    maxConnections: int(env, 'MAX_CONNECTIONS', 5000),
    maxRoomConnections: int(env, 'MAX_ROOM_CONNECTIONS', 300),
    // Long polling holds a request this many seconds (under the mirrors' and Cloudflare's timeouts)
    pollWait: int(env, 'POLL_WAIT_SECONDS', 25),
    // Per connection: this many messages per 10 seconds
    sendBurst: int(env, 'SEND_BURST', 10),
  };
}
