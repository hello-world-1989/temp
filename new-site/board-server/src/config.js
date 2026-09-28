// Settings from the environment. Secrets come from systemd credentials
// ($CREDENTIALS_DIRECTORY/<name>) when present, else from the matching env variable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function cred(name) {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (dir) {
    try {
      return readFileSync(join(dir, name), 'utf8').trim();
    } catch {}
  }
  return (process.env[name.toUpperCase().replace(/-/g, '_')] || '').trim();
}

const int = (name, def) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
};

// "name:sha256hex" per line or comma-separated
export function parseAdmins(text) {
  const out = new Map();
  for (const line of String(text || '').split(/[\n,]/)) {
    const [name, hash] = line.trim().split(':');
    if (name && /^[0-9a-f]{64}$/.test(hash || '')) out.set(hash, name);
  }
  return out;
}

export function loadConfig(env = process.env) {
  return {
    listen: env.LISTEN || '127.0.0.1:8791',
    databaseUrl: cred('db-url') || env.DATABASE_URL,
    boardKey: cred('board-key'),
    admins: parseAdmins(cred('admins')),
    filesDir: env.FILES_DIR || './data/files',
    // Public URL of this site, used in exported files and notifications
    siteUrl: env.SITE_URL || 'https://end-gfw.com',
    maxImages: int('MAX_IMAGES', 6),
    maxImageBytes: int('MAX_IMAGE_BYTES', 8 * 1024 * 1024),
    diskQuotaBytes: int('DISK_QUOTA_BYTES', 10 * 1024 ** 3),
    maxDrafts: int('MAX_DRAFTS', 300),
    maxPendingPosts: int('MAX_PENDING_POSTS', 500),
    maxPendingComments: int('MAX_PENDING_COMMENTS', 3000),
    powBits: { post: int('POW_BITS_POST', 17), comment: int('POW_BITS_COMMENT', 15), report: int('POW_BITS_REPORT', 14) },
    // 1: comments wait for review; 0: shown at once (admins can still remove them)
    commentPremod: env.COMMENT_PREMOD !== '0',
    purgeDays: int('PURGE_DAYS', 7),
    github: {
      token: cred('github-token'),
      repo: env.GITHUB_REPO || '', // owner/name
      branch: env.GITHUB_BRANCH || 'main',
      dir: env.GITHUB_DIR || 'board',
    },
    telegram: { token: cred('tg-bot-token'), chatId: env.TG_CHAT_ID || '' },
  };
}

export const CATEGORIES = ['维权', '抗议', '执法', '灾害事故', '审查删帖', '民生', '其他'];
