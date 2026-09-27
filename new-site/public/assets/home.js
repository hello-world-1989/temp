import { $, api, esc, ymd, addDays } from './site.js';
import { planCard } from './plans-common.js';

async function loadPlans() {
  const box = $('#plans');
  try {
    const plans = await api('/api/plans');
    box.innerHTML = plans.map((p, i) => planCard(p, { featured: i === 1, compact: true })).join('');
  } catch {
    box.innerHTML = `<div class="notice warn">套餐信息暂时无法加载，请稍后刷新，或直接前往 <a href="/plans">高速套餐</a>。</div>`;
  }
}

async function loadNews() {
  const box = $('#news');
  let date = ymd();
  let items = [];
  // Today's file may not exist yet early in the day; fall back up to two days
  for (let i = 0; i < 3 && items.length === 0; i++) {
    try {
      items = await api(`/api/news?date=${date}`);
    } catch {
      items = [];
    }
    if (!items.length) date = addDays(date, -1);
  }
  if (!items.length) {
    box.innerHTML = '<p class="muted">暂时没有新闻。</p>';
    return;
  }
  box.innerHTML = items
    .slice(0, 6)
    .map(
      (n) => `<a class="card item" href="/news?date=${esc(date)}#n${esc(n.id)}">
        <div class="item-meta"><span class="badge soft">${esc(n.name || n.sourceId)}</span><span>${esc(n.createdDate)}</span></div>
        <h3>${esc(n.title)}</h3>
        <p class="muted">${esc(String(n.content || '').slice(0, 80))}…</p>
      </a>`,
    )
    .join('');
}

loadPlans();
loadNews();
