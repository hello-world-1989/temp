// end-gfw.com legacy API on AWS Lambda (function URL, called only by the
// end-gfw-legacy Cloudflare Worker). These are the old site's routes that need a
// secret or MongoDB; everything else runs in the Worker without secrets.
// Settings: /end-gfw/web/* in Parameter Store (same values the web container used).
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { MongoClient } from 'mongodb';

const REGION = process.env.SSM_REGION || 'us-east-1';
const SETTINGS_TTL = 10 * 60 * 1000;
let settings = null;
let settingsAt = 0;
let mongo = null;
let appleCache = null;

async function config() {
  if (settings && Date.now() - settingsAt < SETTINGS_TTL) return settings;
  const ssm = new SSMClient({ region: REGION });
  const out = {};
  let NextToken;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({ Path: '/end-gfw/web/', WithDecryption: true, NextToken }),
    );
    for (const p of res.Parameters ?? []) out[p.Name.slice('/end-gfw/web/'.length)] = p.Value;
    NextToken = res.NextToken;
  } while (NextToken);
  settings = out;
  settingsAt = Date.now();
  return out;
}

const json = (data, status = 200) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});
const text = (data, status = 200) => ({
  statusCode: status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  body: data ?? '',
});

async function get(url, init = {}, timeout = 10000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${new URL(url).host}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const qs = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');

// base64 subscription -> lines
function decodeLines(b64, sep = /\r?\n/) {
  return Buffer.from(String(b64 || '').trim(), 'base64').toString('utf-8').split(sep).filter(Boolean);
}

// Same seeded pick as the old site: a visitor gets the same 4 keys all day
function pickForClient(arr, clientIp, count = 4) {
  if (arr.length <= count) return arr;
  let seed = String(clientIp || '')
    .split('')
    .reduce((acc, ch, i) => acc + ch.charCodeAt(0) * (i + 1), new Date().getDate());
  const a = [...arr];
  for (let i = 0; i < count; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = i + (seed % (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

async function db(cfg) {
  if (!mongo) {
    mongo = new MongoClient(cfg.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await mongo.connect();
  }
  return mongo.db('email').collection('email');
}

async function ipCheck(cfg, ip, port) {
  try {
    const res = await get(`${cfg.IP_CHECK_URL}/${encodeURIComponent(ip)}/${encodeURIComponent(port)}`, {
      headers: {
        Host: cfg.IP_CHECK_HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:115.0esr) Gecko/20010101 Firefox/115.0esr/9S8eMFpqfT',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: cfg.IP_CHECK_REFERER,
      },
    });
    return (await res.json())?.tcp ?? 'fail';
  } catch (e) {
    console.error('ip check:', e.message);
    return 'fail';
  }
}

async function searchTweets(cfg, keyword) {
  const auth = { headers: { Authorization: `Bearer ${cfg.GITHUB_TOKEN}`, 'User-Agent': 'end-gfw' } };
  const q = encodeURIComponent(`${keyword} in:file repo:hello-world-1989/json`);
  const res = await get(`https://api.github.com/search/code?q=${q}`, auth);
  const items = ((await res.json())?.items ?? []).filter((i) => i.name === 'whyyoutouzhele.json');
  const lists = await Promise.all(
    items.map((i) =>
      get(`https://raw.githubusercontent.com/hello-world-1989/json/main/${i.path}`)
        .then((r) => r.json())
        .catch(() => []),
    ),
  );
  return lists.flat().filter((t) => t?.content?.includes(keyword));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

const routes = {
  async '/ss-key'(q, cfg, clientIp) {
    const res = await get(cfg.SUB_URL);
    return text(pickForClient(decodeLines(await res.text(), '\r\n'), clientIp).join('\r\n'));
  },
  async '/ss-key1'(q, cfg) {
    const res = await get(cfg.SUB_URL1);
    let lines = decodeLines(await res.text()).map((l) => l.replace('\\r', '')).filter((l) => !l.startsWith('ss://'));
    if (cfg.SUB_URL2) {
      const res2 = await get(cfg.SUB_URL2);
      lines = lines.concat(decodeLines(await res2.text()).map((l) => l.replace('\\r', '')).filter((l) => !l.startsWith('ss://')));
    }
    return text(lines.join('\r\n'));
  },
  async '/renew-plan'(q, cfg) {
    if (!q.token) return json({ success: false, error: 'Missing required parameters: token', message: 'Validation Error' }, 400);
    if (!TOKEN_RE.test(q.token)) return json({ error: 'Failed to renew plan' });
    // New-system tokens first; tokens it does not know (404) go to the previous system
    let renewed = false;
    if (cfg.XN_RENEW_PLAN_URL) {
      try {
        await get(`${cfg.XN_RENEW_PLAN_URL}?${qs({ token: q.token })}`);
        renewed = true;
      } catch (e) {
        if (e.status !== 404 || !cfg.RENEW_PLAN_URL) throw e;
      }
    }
    if (!renewed) await get(`${cfg.RENEW_PLAN_URL}?${qs({ token: q.token })}`);
    return json({ renewed: true });
  },
  async '/renew-email'(q, cfg) {
    if (!q.email) return json({ success: false, error: 'Missing required parameters: email', message: 'Validation Error' }, 400);
    const email = String(q.email).trim();
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ renewed: false, error: 'Email not found' });
    const expiryDate = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();
    const result = await (await db(cfg)).updateOne(
      { address: email },
      { $set: { expiryDate, lastSignDate: now, updatedAt: now, urgency: 0 } },
    );
    if (result.matchedCount === 0) return json({ renewed: false, error: 'Email not found' });
    if (cfg.XN_API && cfg.XN_BUY_SECRET) {
      const days = Number(cfg.XN_FREE_DAYS ?? 4);
      await get(`${cfg.XN_API.replace(/\/+$/, '')}/plan/free?${qs({ email, days, secret: cfg.XN_BUY_SECRET })}`).catch((e) =>
        console.error('xrayr-next check-in:', e.message),
      );
    }
    return json({ renewed: true, expiryDate });
  },
  async '/apple-account'(q, cfg) {
    // Cached for an hour; the shared account's password changes regularly
    if (appleCache && Date.now() - appleCache.at < 3600 * 1000) return json(appleCache.account);
    const res = await get(cfg.APPLE_ID_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://idshare001.me',
        Referer: 'https://idshare001.me/',
        Cookie: 'last_visited_page=404.html',
      },
    });
    const first = (await res.json().catch(() => []))?.[0] ?? {};
    const account = { username: first.username, password: first.password, expireDate: first.time };
    if (account.password) appleCache = { account, at: Date.now() };
    return json(account);
  },
  async '/ip-check'(q, cfg) {
    const { ip, port = 80 } = q;
    if (!ip) return json({ error: 'Missing required parameter: ip' });
    const ok = /^[\w.-]{1,253}$/.test(ip) && /^\d{1,5}$/.test(String(port));
    const status = ok ? await ipCheck(cfg, ip, port) : 'fail';
    return json({ ip, port, status, timestamp: new Date().toISOString() });
  },
  async '/search-tweet'(q, cfg) {
    if (!q.keyword) return json({ success: false, error: 'Missing required parameters: keyword', message: 'Validation Error' }, 400);
    return json(await searchTweets(cfg, String(q.keyword).slice(0, 100)).catch(() => []));
  },
  async '/event'(q, cfg) {
    if (!/^\d{4}$/.test(q.year ?? '')) return json({ success: false, error: 'Missing required parameters: year', message: 'Validation Error' }, 400);
    try {
      const auth = { headers: { Authorization: `Bearer ${cfg.GITHUB_TOKEN}`, 'User-Agent': 'end-gfw' } };
      const res = await get(`https://api.github.com/search/code?q=${encodeURIComponent('events in:path repo:hello-world-1989/json')}`, auth);
      const items = ((await res.json())?.items ?? []).filter((i) => i.path?.includes(q.year));
      const events = await Promise.all(
        items.map((i) => get(`https://raw.githubusercontent.com/hello-world-1989/json/main/${i.path}`).then((r) => r.json())),
      );
      return json(events.sort((a, b) => a.date - b.date));
    } catch (e) {
      console.error('event:', e.message);
      return json([]);
    }
  },
};

export async function handler(event) {
  const path = event.rawPath || '/';
  const q = event.queryStringParameters || {};
  const clientIp = event.headers?.['x-client-ip'] || '';
  let route = routes[path];
  if (!route && path.startsWith('/url-check/')) {
    route = async (_q, cfg) => {
      const raw = decodeURIComponent(path.slice('/url-check/'.length));
      try {
        const u = new URL(raw);
        const port = u.port || (raw.startsWith('http://') ? 80 : 443);
        return json({ url: raw, hostname: u.hostname, port, status: await ipCheck(cfg, u.hostname, port), timestamp: new Date().toISOString() });
      } catch {
        return json({ url: raw, status: false, timestamp: new Date().toISOString() });
      }
    };
  }
  if (!route) return json({ success: false, error: 'Endpoint not found', message: 'Not Found' }, 404);
  try {
    return await route(q, await config(), clientIp);
  } catch (e) {
    console.error(`${path}:`, e.message);
    if (path === '/ss-key' || path === '/ss-key1') return text('');
    if (path === '/renew-plan' || path === '/renew-email') return json({ error: 'Failed to renew plan' });
    return json({ error: 'Request failed' }, 502);
  }
}

export { pickForClient, decodeLines };
