// 和谐词典: the built-in word list and the shared helpers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORIES, matches, wordOfDay, related, entryHtml, cardHtml, shareCardHtml, description, norm } from '../public/assets/dict-render.js';

const words = JSON.parse(readFileSync(new URL('../dict/words.json', import.meta.url), 'utf8'));
const byWord = (w) => words.find((e) => e.word === w);

test('word list is complete and valid', () => {
  assert.ok(words.length >= 20);
  for (const w of ['死', '最', '钱', '微信', '私信', '自杀', '血', '警察', '赌博', '翻墙', '封城', '疫情', '政府', '一万', '减肥', '医院', '退款', '骗子', '广告', '限流', '移民']) {
    assert.ok(byWord(w), `missing ${w}`);
  }
  assert.ok(byWord('移民').alternatives.includes('润'));
  assert.ok(byWord('疫情').alternatives.includes('口罩'));
  assert.ok(byWord('政府').alternatives.includes('zf'));
  assert.equal(new Set(words.map((w) => w.id)).size, words.length);
  for (const w of words) {
    assert.ok(CATEGORIES.includes(w.category), w.word);
    assert.ok(w.reason && (w.alternatives.length > 0 || w.origin), w.word);
  }
});

test('search finds the word and its alternatives', () => {
  const find = (q) => words.filter((e) => matches(e, q)).map((e) => e.word);
  assert.ok(find('zf').includes('政府'));
  assert.ok(find('ＺＦ').includes('政府'));
  assert.ok(find('润').includes('移民'));
  assert.ok(find('紫砂').includes('自杀'));
  assert.ok(find('政府').includes('政府'));
  assert.equal(find('').length, words.length);
  assert.equal(norm(' A b '), 'ab');
});

test('word of the day: featured date first, else fixed by date for everyone', () => {
  assert.equal(wordOfDay(words, '2026-10-29').word, '死');
  const plain = words.filter((w) => !w.featuredDate);
  const a = wordOfDay(plain, '2026-11-03');
  assert.equal(wordOfDay(plain, '2026-11-03'), a);
  assert.notEqual(wordOfDay(plain, '2026-11-04'), a);
  // consecutive days walk through the whole list
  const seen = new Set();
  for (let i = 0; i < plain.length; i++) seen.add(wordOfDay(plain, new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10)).id);
  assert.equal(seen.size, plain.length);
  assert.equal(wordOfDay([], '2026-10-29'), null);
});

test('HTML escapes visitors\' text', () => {
  const evil = { id: 'x1y2z3w4q5', word: '<img src=x onerror=alert(1)>', alternatives: ['"><script>'], category: '平台限流', reason: '<b>r</b>', example: '&', trivia: '', source: 'user' };
  for (const html of [entryHtml(evil), cardHtml(evil), shareCardHtml(evil, 'site')]) {
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>'), false);
  }
  assert.match(entryHtml(evil), /网友补充/);
  assert.ok(related(byWord('死'), words).every((e) => e.category === '平台限流' && e.word !== '死'));
  assert.ok(description(byWord('政府')).includes('zf'));
});

test('官方话术 entries show what they mean and where they come from', () => {
  const q = byWord('临时工');
  assert.equal(q.category, '官方话术');
  const html = entryHtml(q);
  assert.match(html, /是什么意思/);
  assert.match(html, /出处/);
  assert.match(html, /rel="nofollow noopener noreferrer"/);
  assert.equal(html.includes('替代写法'), false);
  assert.match(cardHtml(q), /替罪羊/);
  assert.match(description(q), /出自哪里/);
  const bad = { ...q, sources: [{ title: 'x', url: 'javascript:alert(1)' }] };
  assert.equal(entryHtml(bad).includes('javascript:'), false);
  assert.ok(words.filter((w) => w.category === '官方话术').every((w) => w.origin && w.sources.length));
});
