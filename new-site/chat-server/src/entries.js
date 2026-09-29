// Addresses 加密聊天 can be opened at, for the backup lines of invite links: the site, the site's
// mirror nodes (https://<IP>/chat) and the chat relays (https://<IP>:8443/chat). Read from the
// website (/api/share/mirrors and /api/chat-mirrors) every 10 minutes; the last good list is kept
// when the website cannot be reached. Served at GET /chat/api/entries.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAX = 20;

export function createEntries({ siteUrl, fetchImpl = globalThis.fetch }) {
  const site = siteUrl ? siteUrl.replace(/\/+$/, '') : '';
  let entries = site ? [{ url: `${site}/chat`, label: '主站' }] : [];

  async function get(path) {
    const res = await fetchImpl(`${site}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function refresh() {
    if (!site) return entries;
    const [share, chat] = await Promise.all([get('/api/share/mirrors'), get('/api/chat-mirrors')]);
    const region = new Map();
    const relays = [];
    for (const m of Array.isArray(chat?.mirrors) ? chat.mirrors : []) {
      const u = safeUrl(m?.url);
      if (!u || u.protocol !== 'https:' || !IPV4.test(u.hostname) || u.port !== '8443' || u.pathname !== '/chat') continue;
      const r = String(m.region || '').slice(0, 20);
      region.set(u.hostname, r);
      relays.push({ url: `https://${u.hostname}:8443/chat`, label: `直连 ${r || u.hostname}` });
    }
    const out = [];
    for (const s of Array.isArray(share?.site) ? share.site : []) {
      const u = safeUrl(s);
      if (u && u.protocol === 'https:' && !IPV4.test(u.hostname) && !u.port) out.push({ url: `https://${u.hostname}/chat`, label: '主站' });
    }
    if (!out.length) out.push({ url: `${site}/chat`, label: '主站' });
    for (const s of Array.isArray(share?.mirrors) ? share.mirrors : []) {
      const u = safeUrl(s);
      if (u && u.protocol === 'https:' && IPV4.test(u.hostname) && !u.port) out.push({ url: `https://${u.hostname}/chat`, label: `镜像 ${region.get(u.hostname) || u.hostname}` });
    }
    out.push(...relays);
    const seen = new Set();
    entries = out.filter((e) => !seen.has(e.url) && seen.add(e.url)).slice(0, MAX);
    return entries;
  }

  return { list: () => entries, refresh };
}

function safeUrl(s) {
  try {
    return typeof s === 'string' ? new URL(s) : null;
  } catch {
    return null;
  }
}
