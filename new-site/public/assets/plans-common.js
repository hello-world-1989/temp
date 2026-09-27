import { esc, fmtPrice } from './site.js';

// One plan card; used on the home page and the plans page
export function planCard(p, { featured = false, compact = false } = {}) {
  const perDay = (Number(p.priceCents) || 0) / 100 / (p.days || 30);
  return `<article class="card plan${featured ? ' featured' : ''}">
    ${featured ? '<span class="badge">最受欢迎</span>' : ''}
    <div class="speed">${esc(p.mbit)} <small>Mbps</small></div>
    <div class="price"><b>${esc(fmtPrice(p.priceCents, p.currency))}</b> <span class="muted">/ ${esc(p.days || 30)} 天</span></div>
    ${
      compact
        ? ''
        : `<ul>
      <li>每天约 ${esc(perDay.toFixed(2))} 美元</li>
      <li>全部节点、全部协议</li>
      <li>一个订阅链接导入所有设备</li>
      <li>一次性付款，不自动扣费</li>
    </ul>`
    }
    <a class="btn ${featured ? 'btn-primary' : 'btn-ghost'}" href="/plans?plan=${esc(p.plan)}#buy">选择 ${esc(p.mbit)}M</a>
  </article>`;
}
