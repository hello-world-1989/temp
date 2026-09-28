// 检查 vpn.json 里软件的上游新版本，下载、打包成原来的 zip 名，覆盖上传到 temp 仓库的 release，
// 并把 vpn.json 对应条目的 date 改成当天。由 .github/workflows/update-apps.yml 调用。
//
// 环境变量：
//   GITHUB_TOKEN   必需；写 release 用
//   GITHUB_REPOSITORY  默认 hello-world-1989/temp
//   DRY_RUN=1      只检查版本和资产名，不下载不上传
//   ONLY=a.zip,b.zip   只处理这些文件
//   FORCE=1        不管版本是否变化都重新上传
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOURCES = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8')).sources;
const STATE_FILE = join(HERE, 'state.json');
const VPN_JSON = join(ROOT, 'public', 'temp', 'vpn.json');
const WORK = join(process.env.RUNNER_TEMP || '/tmp', 'update-apps');

const REPO = process.env.GITHUB_REPOSITORY || 'hello-world-1989/temp';
const TOKEN = process.env.GITHUB_TOKEN;
const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_SIZE = 1024 * 1024; // 小于 1MB 的一律当成错误页面
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

// ---------- helpers
async function gh(path, init = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  if (res.status === 404) return null;
  return res.status === 204 ? {} : res.json();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fill(tpl, version) {
  return tpl.replaceAll('{version}', String(version));
}

// 固定地址：跟随跳转，用最终地址 + ETag/Last-Modified/大小 当版本
async function probe(url) {
  let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!res.ok || !res.headers.get('content-length')) {
    res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Range: 'bytes=0-0' } });
    res.body?.cancel();
  }
  if (!res.ok) throw new Error(`probe ${url} -> ${res.status}`);
  const h = res.headers;
  const size = h.get('content-range')?.split('/')[1] || h.get('content-length') || '';
  return {
    finalUrl: res.url,
    id: [res.url, h.get('etag') || '', h.get('last-modified') || '', size].join('|'),
  };
}

// 上游 GitHub：默认取最新正式版；tagPattern 用于 outline 这种一个仓库多个平台各自发版的情况
async function latestGithub(src) {
  let rel;
  if (src.tagPattern) {
    const re = new RegExp(src.tagPattern, 'i');
    const list = await gh(`/repos/${src.repo}/releases?per_page=100`);
    rel = (list || []).find((r) => !r.draft && !r.prerelease && re.test(r.tag_name));
    if (!rel) throw new Error(`${src.repo}: 没有匹配 /${src.tagPattern}/ 的正式版，最近的 tag：${(list || []).slice(0, 10).map((r) => r.tag_name).join(', ')}`);
  } else {
    rel = await gh(`/repos/${src.repo}/releases/latest`);
    if (!rel) throw new Error(`${src.repo}: 没有正式版 release`);
  }
  const files = src.files.map((pattern) => {
    const re = new RegExp(pattern);
    const hits = rel.assets.filter((a) => re.test(a.name));
    if (hits.length !== 1) {
      throw new Error(`${src.repo}@${rel.tag_name}: /${pattern}/ 匹配到 ${hits.length} 个文件；全部文件：${rel.assets.map((a) => a.name).join(', ')}`);
    }
    const a = hits[0];
    return { url: a.browser_download_url, name: a.name, size: a.size, sha256: a.digest?.startsWith('sha256:') ? a.digest.slice(7) : null };
  });
  return { version: rel.tag_name, files };
}

async function resolve(src) {
  if (src.type === 'github') return latestGithub(src);
  if (src.type === 'template') {
    const version = pick(await getJson(src.version.url), src.version.path);
    if (version == null || version === '') throw new Error(`${src.version.url}: 读不到 ${src.version.path}`);
    let sums = null;
    if (src.sha256sums) {
      const res = await fetch(fill(src.sha256sums, version), { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`sha256sums -> ${res.status}`);
      sums = new Map((await res.text()).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2).map(([h, f]) => [f.replace(/^\*/, ''), h]));
    }
    const files = src.urls.map((t) => {
      const url = fill(t, version);
      const name = decodeURIComponent(basename(new URL(url).pathname));
      const sha256 = sums ? sums.get(name) : null;
      if (sums && !sha256) throw new Error(`sha256sums 里没有 ${name}`);
      return { url, name, sha256 };
    });
    return { version: String(version), files };
  }
  if (src.type === 'url') {
    const probes = await Promise.all(src.urls.map(probe));
    return {
      version: probes.map((p) => p.id).join(' + '),
      files: probes.map((p) => ({ url: p.finalUrl, name: decodeURIComponent(basename(new URL(p.finalUrl).pathname)) || 'download', sha256: null })),
    };
  }
  throw new Error(`unknown type ${src.type}`);
}

function sha256File(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}

function curl(args) {
  execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '5', '--connect-timeout', '30', '-A', UA, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

async function download(f, dir) {
  const out = join(dir, f.name);
  curl(['-o', out, f.url]);
  const size = statSync(out).size;
  if (size < MIN_SIZE) throw new Error(`${f.name} 只有 ${size} 字节，可能下载到了错误页面`);
  if (f.size && size !== f.size) throw new Error(`${f.name} 大小不符：${size} ≠ ${f.size}`);
  const buf = Buffer.alloc(16);
  const fd = openSync(out, 'r');
  readSync(fd, buf, 0, 16, 0);
  closeSync(fd);
  const head = buf.toString('latin1').toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) throw new Error(`${f.name} 是 HTML 页面，不是安装包`);
  if (f.sha256) {
    const got = await sha256File(out);
    if (got !== f.sha256.toLowerCase()) throw new Error(`${f.name} SHA256 不符：${got} ≠ ${f.sha256}`);
  }
  return out;
}

// ---------- release upload：先传成 .new，再删旧的、改名，下载链接不会中断
const releaseCache = new Map();
async function getRelease(tag) {
  if (!releaseCache.has(tag)) {
    const rel = await gh(`/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
    if (!rel) throw new Error(`${REPO} 没有 tag 为 ${tag} 的 release`);
    releaseCache.set(tag, rel);
  }
  return releaseCache.get(tag);
}

async function listAssets(rel) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${REPO}/releases/${rel.id}/assets?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

async function publish(tag, name, file) {
  const rel = await getRelease(tag);
  const tmpName = `${name}.new`;
  for (const a of await listAssets(rel)) {
    if (a.name === tmpName) await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
  }
  const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(tmpName)}`;
  const raw = execFileSync('curl', [
    '-fsS', '--retry', '3', '--retry-delay', '10', '-X', 'POST',
    '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.github+json', '-H', 'Content-Type: application/zip',
    '--data-binary', `@${file}`, uploadUrl,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const uploaded = JSON.parse(raw.toString());
  if (uploaded.size !== statSync(file).size) throw new Error(`${name} 上传后大小不符`);
  for (const a of await listAssets(rel)) {
    if (a.name === name) await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
  }
  await gh(`/repos/${REPO}/releases/assets/${uploaded.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

// ---------- vpn.json
function todayLabel() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${Number(parts.year) % 100}年${Number(parts.month)}月${Number(parts.day)}日更新`;
}

function markUpdated(vpn, tag, name) {
  const link1 = `/download-app/${tag}/${name}`;
  const link2 = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
  let n = 0;
  for (const item of vpn) {
    if (item.link1 === link1 || item.link2 === link2) {
      item.date = todayLabel();
      n++;
    }
  }
  return n;
}

// ---------- main
const vpn = JSON.parse(readFileSync(VPN_JSON, 'utf8'));
const results = [];
let changed = false;

for (const src of SOURCES) {
  if (ONLY.length && !ONLY.includes(src.name)) continue;
  const tag = src.name.split('-')[0];
  const prev = state[src.name]?.version;
  const row = { name: src.name, prev: prev || '-', now: '', status: '' };
  results.push(row);
  try {
    const up = await resolve(src);
    row.now = up.version;
    row.files = up.files.map((f) => f.name).join(', ');
    if (!FORCE && prev === up.version) {
      row.status = '已是最新';
      continue;
    }
    if (DRY) {
      row.status = prev ? '有新版本（dry run）' : '首次（dry run）';
      continue;
    }
    const dir = join(WORK, src.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const paths = [];
    for (const f of up.files) paths.push(await download(f, dir));
    const zipPath = join(WORK, src.name);
    let out = `${zipPath}.out.zip`;
    rmSync(out, { force: true });
    if (src.raw) {
      if (paths.length !== 1) throw new Error('raw 只能有一个文件');
      // 确认是能读出文件目录的 zip（unzip -t 对部分 Windows 打包工具生成的 zip 会误报）
      execFileSync('python3', ['-c', 'import sys,zipfile; n=len(zipfile.ZipFile(sys.argv[1]).namelist()); assert n>0', paths[0]]);
      out = paths[0];
    } else {
      execFileSync('zip', ['-j', '-q', '-X', out, ...paths]);
    }
    await publish(tag, src.name, out);
    const n = markUpdated(vpn, tag, src.name);
    state[src.name] = { version: up.version, files: up.files.map((f) => f.name), updated: new Date().toISOString() };
    changed = true;
    row.status = `已更新（vpn.json ${n} 条）`;
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${zipPath}.out.zip`, { force: true });
  } catch (err) {
    row.status = `失败：${err.message}`;
  }
}

if (changed) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(VPN_JSON, `${JSON.stringify(vpn, null, 2)}\n`);
}

// 结果写进 Actions 的 Summary 页面
const md = [
  `### 软件更新${DRY ? '（dry run）' : ''}`,
  '',
  '| 文件 | 原版本 | 上游版本 | 结果 |',
  '|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${String(r.prev).slice(0, 60)} | ${String(r.now).slice(0, 60)} | ${r.status.replaceAll('|', '\\|').slice(0, 1500)} |`),
].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, { flag: 'a' });

const failed = results.filter((r) => r.status.startsWith('失败'));
if (failed.length) {
  console.error(`${failed.length} 个失败`);
  process.exitCode = 1;
}
