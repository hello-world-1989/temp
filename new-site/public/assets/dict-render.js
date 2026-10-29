// 和谐词典: data helpers and HTML for entries. Plain functions without the DOM, so the build
// (scripts/build.mjs, static word pages) and the pages in the browser render the same markup.
// Everything that goes into HTML passes through esc(); user-submitted words are plain text.

export const SITE_NAME = '和谐词典';
export const CATEGORIES = ['平台限流', '广告法', '政治审查', '引流/联系方式', '健康医疗', '金钱交易', '官方话术'];
// 官方话术: official phrases and notorious quotes the internet took up. They have no 替代写法;
// `reason` says what the phrase really means and `origin` / `sources` say where it came from.
const hasAlts = (entry) => Array.isArray(entry.alternatives) && entry.alternatives.length > 0;

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const wordUrl = (entry) => `/dict/words/${encodeURIComponent(entry.id)}`;

// Lower case, full-width letters and digits to half-width, no spaces: "ＺＦ" and "z f" find "zf"
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

// Matches the word itself and every 替代写法
export function matches(entry, query) {
  const q = norm(query);
  if (!q) return true;
  return [entry.word, ...(entry.alternatives || [])].some((s) => norm(s).includes(q));
}

// 今日一词: the entry whose featuredDate is that day, else (days since 1970-01-01) mod count.
// Only the built-in list is used, so every visitor sees the same word for a date and history
// does not move when submissions are added. `date` is YYYY-MM-DD (Beijing time).
export function wordOfDay(entries, date) {
  if (!entries.length) return null;
  const featured = entries.find((e) => e.featuredDate === date);
  if (featured) return featured;
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  return entries[((days % entries.length) + entries.length) % entries.length];
}

export function related(entry, all, n = 6) {
  return all.filter((e) => e.category === entry.category && e.id !== entry.id).slice(0, n);
}

export function description(entry) {
  if (!hasAlts(entry)) return `“${entry.word}”是什么意思、出自哪里：${entry.reason}`.slice(0, 160);
  return `“${entry.word}”在中国社交平台上常被写成${entry.alternatives.slice(0, 4).map((a) => `“${a}”`).join('、')}。${entry.reason}`.slice(0, 160);
}

// Alternatives as buttons: a click copies (site.js handles [data-copy])
function altTags(entry, cls = 'dict-alt') {
  return entry.alternatives.map((a) => `<button type="button" class="${cls}" data-copy="${esc(a)}" title="点击复制">${esc(a)}</button>`).join('');
}

export function cardHtml(entry) {
  return `<a class="dict-card" href="${wordUrl(entry)}">
  <span class="dict-card-head">${wordHtml(entry)}<span class="dict-cat">${esc(entry.category)}</span></span>
  ${hasAlts(entry) ? `<span class="dict-card-alts">${entry.alternatives.slice(0, 5).map((a) => `<span class="dict-alt dict-alt-sm">${esc(a)}</span>`).join('')}</span>` : `<span class="dict-card-ex">${esc(entry.reason.slice(0, 60))}${entry.reason.length > 60 ? '…' : ''}</span>`}
  ${entry.example ? `<span class="dict-card-ex">${esc(entry.example)}</span>` : ''}
  ${entry.source === 'user' ? '<span class="dict-card-src">网友补充</span>' : ''}
</a>`;
}

// The word itself: struck through when it "cannot be said"; long quotes get a smaller size
function wordHtml(entry) {
  const cls = [hasAlts(entry) ? 'dict-strike' : 'dict-quote', [...entry.word].length > 5 ? 'dict-long' : ''].filter(Boolean).join(' ');
  return `<span class="${cls}">${esc(entry.word)}</span>`;
}

const safeLink = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : '');

// 出处: the story, then the links (opened without a referrer)
function originHtml(entry) {
  const links = (entry.sources || []).filter((x) => safeLink(x.url));
  if (!entry.origin && !links.length) return '';
  const list = links.map((x) => `<a href="${esc(safeLink(x.url))}" rel="nofollow noopener noreferrer" target="_blank">${esc(x.title || x.url)}</a>`).join('、');
  return `<div><dt>出处</dt><dd>${esc(entry.origin || '')}${list ? `<span class="dict-sources">来源：${list}</span>` : ''}</dd></div>`;
}

// The full entry: big word, alternatives (if any), reason, origin, example, trivia
export function entryHtml(entry, { headingTag = 'h1', link = false } = {}) {
  const h = headingTag;
  const alts = hasAlts(entry);
  return `<article class="dict-entry" data-id="${esc(entry.id)}">
  <div class="dict-entry-top">
    <a class="dict-cat" href="/dict/words?c=${encodeURIComponent(entry.category)}">${esc(entry.category)}</a>
    ${entry.source === 'user' ? '<span class="dict-cat dict-cat-user">网友补充</span>' : ''}
  </div>
  <${h} class="dict-big">${wordHtml(entry)}</${h}>
  ${alts ? `<p class="dict-label">替代写法 <span class="muted">（点击复制）</span></p>
  <div class="dict-alts">${altTags(entry)}</div>` : ''}
  <dl class="dict-notes">
    <div><dt>${alts ? '为什么不能直接写' : '是什么意思'}</dt><dd>${esc(entry.reason)}</dd></div>
    ${originHtml(entry)}
    ${entry.example ? `<div><dt>例句</dt><dd class="dict-example">${esc(entry.example)}</dd></div>` : ''}
    ${entry.trivia ? `<div><dt>小知识</dt><dd>${esc(entry.trivia)}</dd></div>` : ''}
  </dl>
  <div class="dict-actions">
    <button type="button" class="btn btn-primary btn-sm" data-dict-card="${esc(entry.id)}">生成分享图片</button>
    ${link ? `<a class="btn btn-ghost btn-sm" href="${wordUrl(entry)}">词条页面</a>` : ''}
  </div>
</article>`;
}

export function relatedHtml(entry, all) {
  const list = related(entry, all);
  if (!list.length) return '';
  return `<h2 class="dict-h2">同类词条 · ${esc(entry.category)}</h2><div class="dict-grid">${list.map(cardHtml).join('')}</div>`;
}

// 3:4 share card (exported to PNG by html-to-image in dict-common.js)
export function shareCardHtml(entry, siteHost) {
  return `<div class="dict-share">
  <div class="dict-share-cat">${esc(entry.category)}</div>
  <div class="dict-share-word">${wordHtml(entry)}</div>
  ${hasAlts(entry) ? `<div class="dict-share-label">网友这样写</div>
  <div class="dict-share-alts">${entry.alternatives.slice(0, 6).map((a) => `<span>${esc(a)}</span>`).join('')}</div>` : `<div class="dict-share-meaning">${esc(entry.reason.slice(0, 90))}${entry.reason.length > 90 ? '…' : ''}</div>`}
  ${entry.example ? `<div class="dict-share-ex">“${esc(entry.example)}”</div>` : ''}
  <div class="dict-share-foot"><strong>${SITE_NAME}</strong><span>${esc(siteHost)}/dict</span></div>
</div>`;
}
