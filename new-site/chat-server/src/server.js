// Entry point. Listeners (see config.js): LISTEN_TLS for browsers through the mirrors,
// LISTEN_ACME for certificate checks and mirror check-ins, LISTEN_HTTP for local use only.
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';
import { createEdge } from './edge.js';
import { createCerts, createAcmeHandler } from './certs.js';
import { createEntries } from './entries.js';

const config = loadConfig();
mkdirSync(config.certDir, { recursive: true, mode: 0o700 });
mkdirSync(join(config.webroot, '.well-known', 'acme-challenge'), { recursive: true });
const store = openStore(config.dbFile);
const entries = createEntries({ siteUrl: config.siteUrl });
const app = createApp({ store, config, entries });
const certs = createCerts({ store, config });

const servers = [];
function listen(server, where, name) {
  server.listen(where.port, where.host, () => console.log(`${name} listening on ${where.host}:${where.port}`));
  servers.push(server);
}

// One HTTP server behind both the TLS edge and the local listener
const web = http.createServer(app.handler);
web.requestTimeout = 30_000;
web.headersTimeout = 20_000;
web.keepAliveTimeout = 30_000;
web.on('upgrade', app.upgrade);
if (config.listenHttp) listen(web, config.listenHttp, 'local http');
if (config.listenTls) listen(createEdge({ httpServer: web, certs, config }), config.listenTls, 'tls');
if (config.listenAcme) {
  const acme = http.createServer(createAcmeHandler({ certs, config }));
  acme.requestTimeout = 10_000;
  listen(acme, config.listenAcme, 'acme');
}
if (!config.acmeSh) console.warn('ACME_SH not set: no certificates will be issued');

const every = (ms, fn) =>
  setInterval(() => {
    try {
      fn();
    } catch (err) {
      console.error('housekeeping failed', err.message);
    }
  }, ms).unref();
every(5_000, app.sweep);
every(30_000, app.heartbeat);
every(60_000, store.checkpoint);
every(3600_000, app.sweepRooms);
every(30 * 60_000, certs.renewAll);
app.sweepRooms();
const refreshEntries = () => entries.refresh().catch((err) => console.error('chat entries not refreshed', err.message));
refreshEntries();
setInterval(refreshEntries, 10 * 60_000).unref();
certs.renewAll();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const ws of app.wss.clients) ws.close(1012, 'restart');
    for (const s of servers) s.close();
    store.checkpoint();
    store.close();
    process.exit(0);
  });
}
