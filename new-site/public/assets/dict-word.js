// 和谐词典 词条页 (/dict/words/<id>). Built-in words are pre-rendered by the build (full HTML
// for search engines); words added by visitors use the /dict/word page and are loaded here.
import { $ } from './site.js';
import { description, entryHtml, relatedHtml } from './dict-render.js';
import { PRESET, findWord, loadUserWords, registerEntries } from './dict-common.js';

registerEntries(PRESET);

async function showUserWord() {
  const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const entry = await findWord(id);
  if (!entry) {
    $('#entry').innerHTML = '<div class="dict-empty">没有找到这个词条，可能还在审核或已被删除。<br><a href="/dict/words">去词库看看</a></div>';
    return;
  }
  registerEntries([entry]);
  $('#entry').innerHTML = entryHtml(entry);
  document.title = `${entry.word}：替代写法 ${entry.alternatives.slice(0, 3).join('、')} | 和谐词典 | 大翻墙运动`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', description(entry));
  const all = [...PRESET, ...(await loadUserWords())];
  $('#related').innerHTML = relatedHtml(entry, all);
}

if (!document.querySelector('#entry .dict-entry')) showUserWord();
