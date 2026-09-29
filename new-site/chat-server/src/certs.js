// Let's Encrypt IP certificates for the mirrors, issued here with acme.sh (http-01).
//
// A mirror checks in with GET /.well-known/end-gfw-chat/hello on the ACME port; its address as
// seen here is the IP to certify. Let's Encrypt then fetches the challenge from
// http://<mirror IP>/.well-known/acme-challenge/..., which the mirror's nginx passes on to the
// same port here, so a certificate is only ever issued for an address that really forwards to
// this server. IP certificates are short-lived (about 6 days) and renewed 2 days before expiry.
// The private keys never leave this machine.
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';
import { isPublicIPv4 } from './edge.js';

const RENEW_BEFORE = 2 * 86400_000;
const RETRY_AFTER = 3600_000;
const SEEN_WRITE_EVERY = 10 * 60_000;

export function createCerts({ store, config, now = () => Date.now(), run = runAcme }) {
  const cache = new Map(); // ip -> { ctx, notAfter, mtime, checked }
  const lastSeen = new Map(); // ip -> last time written to the store
  const queue = [];
  const issuedAt = []; // times of recent issuance attempts (rate limit)
  let busy = false;

  const dir = (ip) => join(config.certDir, ip);

  function load(ip) {
    const t = now();
    const c = cache.get(ip);
    if (c && t - c.checked < 60_000) return c;
    let mtime = 0;
    try {
      mtime = statSync(join(dir(ip), 'fullchain.pem')).mtimeMs;
    } catch {
      cache.delete(ip);
      return null;
    }
    if (c && c.mtime === mtime) {
      c.checked = t;
      return c;
    }
    try {
      const cert = readFileSync(join(dir(ip), 'fullchain.pem'));
      const key = readFileSync(join(dir(ip), 'key.pem'));
      const notAfter = new Date(new X509Certificate(cert).validTo).getTime();
      const entry = { ctx: tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' }), notAfter, mtime, checked: t };
      cache.set(ip, entry);
      return entry;
    } catch (err) {
      console.error(`certificate for ${ip} unreadable`, err.message);
      cache.delete(ip);
      return null;
    }
  }

  const valid = (ip, margin = 0) => {
    const c = load(ip);
    return !!c && c.notAfter - now() > margin;
  };

  function status(ip) {
    if (valid(ip)) return 'ok';
    if (queue.includes(ip)) return 'pending';
    const m = store.mirrors().find((r) => r.ip === ip);
    return m?.failed_at && now() - m.failed_at < RETRY_AFTER ? 'failed' : 'pending';
  }

  function want(ip) {
    if (!config.acmeSh || !isPublicIPv4(ip) || queue.includes(ip) || valid(ip, RENEW_BEFORE)) return;
    const m = store.mirrors().find((r) => r.ip === ip);
    if (m?.failed_at && now() - m.failed_at < RETRY_AFTER) return;
    queue.push(ip);
    pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const t = now();
        while (issuedAt.length && t - issuedAt[0] > 3600_000) issuedAt.shift();
        if (issuedAt.length >= config.issuePerHour) {
          console.warn(`certificate limit reached (${config.issuePerHour}/hour); ${queue.length} waiting`);
          queue.length = 0; // the next check-in or renewal pass asks again
          break;
        }
        const ip = queue[0];
        issuedAt.push(t);
        try {
          await issue(ip);
          console.log(`certificate issued for ${ip}`);
        } catch (err) {
          console.error(`certificate for ${ip} failed`, err.message);
          store.mirrorFailed(ip, now());
        }
        queue.shift();
      }
    } finally {
      busy = false;
    }
  }

  async function issue(ip) {
    const base = ['--home', config.acmeHome, '--config-home', config.acmeHome, '--server', 'letsencrypt'];
    await run(config.acmeSh, [...base, '--issue', '--force', '-d', ip, '--webroot', config.webroot, '--cert-profile', 'shortlived', '--days', '3']);
    const src = [join(config.acmeHome, `${ip}_ecc`), join(config.acmeHome, ip)].find((d) => existsSync(join(d, 'fullchain.cer')));
    if (!src) throw new Error('acme.sh left no certificate');
    const tmp = `${dir(ip)}.new`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    copyFileSync(join(src, `${ip}.key`), join(tmp, 'key.pem'));
    copyFileSync(join(src, 'fullchain.cer'), join(tmp, 'fullchain.pem'));
    rmSync(dir(ip), { recursive: true, force: true });
    renameSync(tmp, dir(ip));
    cache.delete(ip);
  }

  return {
    has: (ip) => !!load(ip),
    context: (ip) => load(ip)?.ctx || null,
    status,
    // A mirror at `ip` is alive: remember it and get it a certificate if it has none
    seen(ip) {
      if (!isPublicIPv4(ip)) return;
      const t = now();
      if (t - (lastSeen.get(ip) || 0) > SEEN_WRITE_EVERY) {
        lastSeen.set(ip, t);
        store.mirrorSeen(ip, t);
      }
      want(ip);
    },
    // A connection came in through the mirror at `ip`, which has a certificate: keep it alive
    touch(ip) {
      const t = now();
      if (!isPublicIPv4(ip) || t - (lastSeen.get(ip) || 0) <= SEEN_WRITE_EVERY) return;
      lastSeen.set(ip, t);
      store.mirrorSeen(ip, t);
    },
    // Every 30 minutes: renew what is about to expire, forget mirrors that went away
    renewAll() {
      const t = now();
      for (const m of store.mirrors()) {
        if (t - m.last_seen > config.mirrorDays * 86400_000) {
          store.deleteMirror(m.ip);
          rmSync(dir(m.ip), { recursive: true, force: true });
          for (const d of [`${m.ip}_ecc`, m.ip]) rmSync(join(config.acmeHome, d), { recursive: true, force: true });
          cache.delete(m.ip);
          lastSeen.delete(m.ip);
          continue;
        }
        want(m.ip);
      }
    },
    idle: () => !busy && !queue.length,
  };
}

function runAcme(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => (out = (out + d).slice(-4000));
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`acme.sh exited ${code}: ${out.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

// Plain HTTP on the ACME port, reached only through the mirrors' port 80
export function createAcmeHandler({ certs, config }) {
  return (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (config.allowFrom.size && !config.allowFrom.has(ip)) {
      res.writeHead(403).end();
      return;
    }
    const tok = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{10,128})$/.exec(path);
    if (tok && req.method === 'GET') {
      try {
        const body = readFileSync(join(config.webroot, '.well-known', 'acme-challenge', tok[1]));
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    if (path === '/.well-known/end-gfw-chat/hello' && req.method === 'GET') {
      certs.seen(ip);
      const body = JSON.stringify({ ip, cert: isPublicIPv4(ip) ? certs.status(ip) : 'not a public IPv4 address' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  };
}
