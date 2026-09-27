// Builds public/*.html from pages/*.html, inserting the shared partials.
// A page starts with a front-matter block:
//   <!--
//   title: 页面标题
//   description: 搜索摘要
//   nav: plans
//   -->
// and may use {{> header}} / {{> footer}}; both are inserted automatically when absent.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const partial = (name) => read(`partials/${name}.html`);

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

mkdirSync(join(root, 'public'), { recursive: true });
let count = 0;
for (const file of readdirSync(join(root, 'pages')).filter((f) => f.endsWith('.html'))) {
  const src = read(`pages/${file}`);
  const m = src.match(/^<!--\n([\s\S]*?)\n-->\n/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m ? src.slice(m[0].length) : src;
  const title = meta.title ? `${meta.title} | 大翻墙运动` : '大翻墙运动 · 免费翻墙节点与订阅';
  let header = partial('header');
  // Mark the current section in the navigation
  if (meta.nav) header = header.replaceAll(`data-nav="${meta.nav}"`, `data-nav="${meta.nav}" aria-current="page"`);
  const head = partial('head')
    .replace('{{title}}', esc(title))
    .replace('{{description}}', esc(meta.description || '公益项目：免费翻墙节点与订阅、翻墙软件下载和每日新闻。'))
    .replace('{{extraHead}}', meta.script ? `<script type="module" src="/assets/${meta.script}"></script>` : '');
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    head,
    `<body class="page-${file.replace('.html', '')}">`,
    body.includes('{{> header}}') ? '' : header,
    body.replace('{{> header}}', header).replace('{{> footer}}', partial('footer')),
    body.includes('{{> footer}}') ? '' : partial('footer'),
    '</body>',
    '</html>',
    '',
  ].join('\n');
  writeFileSync(join(root, 'public', file), html);
  count++;
}
console.log(`built ${count} pages`);
