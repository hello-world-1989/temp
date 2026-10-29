// 和谐词典 今日一词 (/dict): the same word for everyone on a given day (Beijing time);
// 上一天 / 下一天 browse earlier days, ?d=YYYY-MM-DD links to one
import { $, ymd, addDays } from './site.js';
import { entryHtml, wordOfDay } from './dict-render.js';
import { PRESET, registerEntries } from './dict-common.js';

registerEntries(PRESET);
const today = ymd();
const asked = new URLSearchParams(location.search).get('d') || '';
let day = /^\d{4}-\d{2}-\d{2}$/.test(asked) && !Number.isNaN(Date.parse(asked)) && asked <= today ? asked : today;

const WEEK = '日一二三四五六';
function label(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const diff = Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
  return {
    date: `${y}年${m}月${dd}日 星期${WEEK[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}`,
    rel: diff === 0 ? '今日一词' : diff === 1 ? '昨天的词' : `${diff} 天前的词`,
  };
}

function render() {
  const entry = wordOfDay(PRESET, day);
  const l = label(day);
  $('#day-date').textContent = l.date;
  $('#day-rel').textContent = l.rel;
  $('#today').innerHTML = entryHtml(entry, { headingTag: 'h2', link: true });
  $('#next').disabled = day >= today;
  const q = day === today ? location.pathname : `${location.pathname}?d=${day}`;
  history.replaceState(null, '', q);
  document.title = `${day === today ? '今日一词' : l.date}：${entry.word} | 和谐词典 | 大翻墙运动`;
}

$('#prev').addEventListener('click', () => {
  day = addDays(day, -1);
  render();
});
$('#next').addEventListener('click', () => {
  if (day < today) day = addDays(day, 1);
  render();
});
render();
