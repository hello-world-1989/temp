// Entry point: HTTP server on LISTEN (127.0.0.1 only; Caddy terminates TLS in front),
// schema migration on start, cleanup every 10 minutes.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp, cleanup } from './app.js';
import { createPublisher } from './publish.js';

pg.types.setTypeParser(1082, (v) => v); // DATE as 'YYYY-MM-DD', no timezone shift

const config = loadConfig();
if (!config.databaseUrl && !process.env.PGHOST) throw new Error('DATABASE_URL (or PGHOST/PGDATABASE/PGUSER for a Unix socket) is required');
if (!config.boardKey || config.boardKey.length < 32) throw new Error('board-key credential (32+ chars) is required');
if (!config.admins.size) console.warn('no admins configured: the review queue cannot be used');

// DATABASE_URL (or the PG* variables). With db-ca, TLS trusts exactly that certificate: the
// database on Debian-1-1 has a self-signed one for its hostname, and is reached by private IP,
// so the name is not checked but the certificate itself must match.
const ssl = config.dbCa ? { ca: config.dbCa, checkServerIdentity: () => undefined } : undefined;
const db = new pg.Pool({ ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {}), ssl, max: 8 });
await db.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

const publisher = createPublisher(config);
const handler = createApp({ db, config, publisher });
const server = http.createServer(handler);
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;

const [host, port] = config.listen.split(':');
server.listen(Number(port), host, () => console.log(`board listening on ${config.listen}`, publisher.enabled));

const sweep = () => cleanup(db, config).catch((err) => console.error('cleanup failed', err.message));
sweep();
setInterval(sweep, 10 * 60 * 1000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => db.end().then(() => process.exit(0))));
}
