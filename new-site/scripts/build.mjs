// Builds public/*.html from pages/*.html, inserting the shared partials.
// A page starts with a front-matter block:
//   <!--
//   title: 页面标题
//   description: 搜索摘要
//   nav: plans
//   -->
// and may use {{> header}} / {{> footer}}; both are inserted automatically when absent.
// "ads: off" in the front matter leaves out ads.js (and marks the page noindex).
// {{> ad}} inserts the manual AdSense display unit (partials/ad.html); any other {{> name}}
// inserts partials/name.html.
// Optional front matter: `script: x.js`, `style: x.css` (or several, space-separated), `ads: off` (no AdSense script on the page,
// and noindex unless `index: on`), `dictnav: words` (marks the 和谐词典 section tab).
// Pages in subfolders (pages/dict/words.html) are built to the same path (public/dict/words.html,
// served as /dict/words).
//
// 和谐词典: every word in dict/words.json gets its own page public/dict/words/<id>.html from
// pages/dict/word.html, and public/assets/dict-data.js carries the list for the browser.
// public/sitemap.xml lists every indexable page.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const partial = (name) => read(`partials/${name}.html`);
const SITE = 'https://end-gfw.com';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const dict = await import(pathToFileURL(join(root, 'public/assets/dict-render.js')).href);
const words = JSON.parse(read('dict/words.json'));
checkWords(words);

function parse(src) {
  const m = src.match(/^<!--\n([\s\S]*?)\n-->\n/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m ? src.slice(m[0].length) : src };
}

// -> { html, indexed }
function render({ meta, body }, name) {
  const title = meta.title ? `${meta.title} | 大翻墙运动` : '大翻墙运动 · 免费翻墙节点与订阅';
  let header = partial('header');
  // Mark the current section in the navigation
  if (meta.nav) header = header.replaceAll(`data-nav="${meta.nav}"`, `data-nav="${meta.nav}" aria-current="page"`);
  let head = partial('head')
    .replace('{{title}}', esc(title))
    .replace('{{description}}', esc(meta.description || '公益项目：免费翻墙节点与订阅、翻墙软件下载和每日新闻。'))
    .replace('{{extraHead}}', [
      meta.canonical ? `<link rel="canonical" href="${esc(meta.canonical)}">` : '',
      ...(meta.style ? meta.style.split(/\s+/).map((f) => `<link rel="stylesheet" href="/assets/${f}">`) : []),
      meta.script ? `<script type="module" src="/assets/${meta.script}"></script>` : '',
    ].filter(Boolean).join('\n'));
  // "ads: off" — no AdSense or any other third-party script (pages with secrets in the URL,
  // and pages where people write or submit things)
  // `index: on` keeps an ads-free page in search results (事件墙 event pages, 和谐词典)
  const indexed = meta.ads !== 'off' || meta.index === 'on';
  if (meta.ads === 'off') head = head.replace('<script src="/assets/ads.js" async></script>\n', indexed ? '' : '<meta name="robots" content="noindex, nofollow">\n');
  let main = body.replace('{{> header}}', header).replace('{{> footer}}', partial('footer'));
  main = main.replace(/\{\{> ([a-z][\w-]*)\}\}/g, (_, p) => partial(p));
  if (meta.dictnav) main = main.replaceAll(`data-dnav="${meta.dictnav}"`, `data-dnav="${meta.dictnav}" aria-current="page"`);
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    head,
    `<body class="page-${name.replaceAll('/', '-')}">`,
    body.includes('{{> header}}') ? '' : header,
    main,
    body.includes('{{> footer}}') ? '' : partial('footer'),
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { html, indexed };
}

function out(rel, html) {
  mkdirSync(dirname(join(root, 'public', rel)), { recursive: true });
  writeFileSync(join(root, 'public', rel), html);
}

// pages/**/*.html (relative paths without .html)
function pageNames(dir = '') {
  const names = [];
  for (const f of readdirSync(join(root, 'pages', dir)).sort()) {
    const rel = dir ? `${dir}/${f}` : f;
    if (statSync(join(root, 'pages', rel)).isDirectory()) names.push(...pageNames(rel));
    else if (f.endsWith('.html')) names.push(rel.slice(0, -5));
  }
  return names;
}

const sitemap = [];
const urlOf = (name) => (name === 'index' ? '/' : `/${name}`);
let count = 0;
for (const name of pageNames()) {
  const { html, indexed } = render(parse(read(`pages/${name}.html`)), name);
  out(`${name}.html`, html);
  // dict/word is only the shell for visitors' words; 404 is not a page
  if (indexed && !['404', 'dict/word', 'board-post'].includes(name)) sitemap.push(urlOf(name));
  count++;
}

// 和谐词典 word pages, rendered in full (search engines see the content without scripts)
rmSync(join(root, 'public/dict/words'), { recursive: true, force: true });
const wordPage = parse(read('pages/dict/word.html'));
for (const w of words) {
  const meta = {
    ...wordPage.meta,
    title: `${w.word}：替代写法 ${w.alternatives.slice(0, 3).join('、')} | 和谐词典`,
    description: dict.description(w),
    canonical: `${SITE}${dict.wordUrl(w)}`,
  };
  const body = wordPage.body
    .replace('<div id="entry"></div>', `<div id="entry">${dict.entryHtml(w)}</div>`)
    .replace('<div id="related"></div>', `<div id="related">${dict.relatedHtml(w, words)}</div>`);
  out(`dict/words/${w.id}.html`, render({ meta, body }, 'dict/word').html);
  sitemap.push(dict.wordUrl(w));
  count++;
}
out('assets/dict-data.js', `// Generated by scripts/build.mjs from dict/words.json — edit that file, not this one\nexport default ${JSON.stringify(words)};\n`);

out('sitemap.xml', [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...sitemap.map((u) => `  <url><loc>${esc(SITE + u)}</loc></url>`),
  '</urlset>',
  '',
].join('\n'));
console.log(`built ${count} pages, sitemap ${sitemap.length} urls`);

// dict/words.json: fail the build on a broken entry rather than publish it
function checkWords(list) {
  const ids = new Set();
  const seen = new Set();
  for (const [i, w] of list.entries()) {
    const where = `dict/words.json #${i + 1} (${w.word || w.id || '?'})`;
    if (!/^[a-z0-9-]{1,40}$/.test(w.id || '')) throw new Error(`${where}: id must be lowercase letters, digits or -`);
    if (ids.has(w.id)) throw new Error(`${where}: duplicate id`);
    if (seen.has(w.word)) throw new Error(`${where}: duplicate word`);
    ids.add(w.id);
    seen.add(w.word);
    if (!w.word || !w.reason) throw new Error(`${where}: word and reason are required`);
    if (!Array.isArray(w.alternatives)) throw new Error(`${where}: alternatives must be a list`);
    // 官方话术 entries have no 替代写法 but must say where they come from
    if (!w.alternatives.length && !w.origin) throw new Error(`${where}: needs alternatives, or origin (出处) for 官方话术`);
    for (const x of w.sources || []) if (!/^https?:\/\//.test(x.url || '')) throw new Error(`${where}: source url must start with http(s)://`);
    if (!dict.CATEGORIES.includes(w.category)) throw new Error(`${where}: category must be one of ${dict.CATEGORIES.join(' ')}`);
    if (w.featuredDate && !/^\d{4}-\d{2}-\d{2}$/.test(w.featuredDate)) throw new Error(`${where}: featuredDate must be YYYY-MM-DD`);
  }
}
