// 和谐词典 词库 (/dict/words): every entry, searchable by the word or any 替代写法
// (searching "zf" finds 政府), filtered by category; ?q= and ?c= keep the view in the link
import { $, esc } from './site.js';
import { CATEGORIES, cardHtml, matches } from './dict-render.js';
import { PRESET, loadUserWords } from './dict-common.js';

const params = new URLSearchParams(location.search);
let query = params.get('q') || '';
let cat = CATEGORIES.includes(params.get('c')) ? params.get('c') : '';
let all = PRESET;

const input = $('#q');
input.value = query;

function renderTabs() {
  const box = $('#cats');
  box.innerHTML = ['', ...CATEGORIES]
    .map((c) => `<button type="button" class="tab" role="tab" data-cat="${esc(c)}" aria-selected="${c === cat}">${esc(c || '全部')}</button>`)
    .join('');
}

function render() {
  const list = all.filter((e) => (!cat || e.category === cat) && matches(e, query));
  $('#grid').innerHTML = list.map(cardHtml).join('');
  $('#count').textContent = query || cat ? `找到 ${list.length} 个词条` : `共 ${all.length} 个词条`;
  $('#empty').classList.toggle('hidden', list.length > 0);
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  if (cat) p.set('c', cat);
  history.replaceState(null, '', p.size ? `${location.pathname}?${p}` : location.pathname);
}

input.addEventListener('input', () => {
  query = input.value.trim();
  render();
});
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  input.blur();
});
$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  cat = b.dataset.cat;
  renderTabs();
  render();
});

renderTabs();
render();
loadUserWords().then((words) => {
  if (!words.length) return;
  const known = new Set(PRESET.map((e) => e.word));
  all = [...PRESET, ...words.filter((w) => !known.has(w.word))];
  render();
});
