import { $, api, esc } from './site.js';

const FIRST_YEAR = 2022;
const thisYear = new Date().getFullYear();
const params = new URLSearchParams(location.search);
let year = Number(params.get('year')) || thisYear;
if (year < FIRST_YEAR || year > thisYear) year = thisYear;

function tabs() {
  const years = [];
  for (let y = thisYear; y >= FIRST_YEAR; y--) years.push(y);
  $('#years').innerHTML = years
    .map((y) => `<button class="tab" type="button" role="tab" data-year="${y}" aria-selected="${y === year}">${y} 年</button>`)
    .join('');
}

async function load() {
  tabs();
  const box = $('#timeline');
  box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  let data = [];
  try {
    data = await api(`/api/events?year=${year}`);
  } catch {
    box.innerHTML = '<div class="notice warn">事件数据暂时无法加载，请稍后刷新。</div>';
    return;
  }
  if (!data.length) {
    box.innerHTML = '<p class="muted">这一年还没有整理好的事件。</p>';
    return;
  }
  // Newest month first
  box.innerHTML = [...data]
    .sort((a, b) => Number(b.date) - Number(a.date))
    .map((item) => {
      const ym = String(item.date || '');
      const y = ym.slice(0, 4);
      const m = ym.slice(4);
      const words = (item.data || []).map((d) => d.keyword).filter(Boolean);
      return `<article class="card item event">
        <div class="event-head">
          <h3>${esc(y)} 年 ${esc(Number(m))} 月</h3>
          <a href="/tweet-page?year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}&id=whyyoutouzhele" target="_blank" rel="noopener">查看当月浏览量最多的推文 →</a>
        </div>
        <div class="chips">${words.map((w) => `<span class="badge soft">${esc(w)}</span>`).join('')}</div>
      </article>`;
    })
    .join('');
}

$('#years').addEventListener('click', (e) => {
  const t = e.target.closest('[data-year]');
  if (!t) return;
  year = Number(t.dataset.year);
  history.replaceState(null, '', `?year=${year}`);
  load();
});

load();
