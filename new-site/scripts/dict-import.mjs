// 和谐词典: merge words into dict/words.json (the built-in list).
//
//   node scripts/dict-import.mjs <file.json> [--dry-run]
//   node scripts/dict-import.mjs --from-api https://end-gfw.com/api/board/dict [--dry-run]
//
// The input is a JSON array (or { items: [...] }, as the API returns) of
//   { "word": "移民", "alternatives": ["润", "run"], "category": "政治审查", "reason": "…",
//     "example": "…", "trivia": "…", "id": "yimin" }
// e.g. from a crawler, a spreadsheet export, or the words visitors added and admins approved.
// A word already in the list only gains the new alternatives (and an example / trivia where it
// had none); its other text is kept. A new word needs word, alternatives, category and reason;
// without an id it gets one made from the word. Run `npm run build` afterwards; the build
// checks the result again.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../public/assets/dict-render.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'dict/words.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const api = args.includes('--from-api') ? args[args.indexOf('--from-api') + 1] : '';
const src = args.find((a) => !a.startsWith('--') && a !== api);
if (!api && !src) {
  console.error('usage: node scripts/dict-import.mjs <file.json> | --from-api <url>  [--dry-run]');
  process.exit(1);
}

const raw = api ? await (await fetch(api, { headers: { Accept: 'application/json' } })).json() : JSON.parse(readFileSync(src, 'utf8'));
const incoming = Array.isArray(raw) ? raw : raw.items || [];
const words = JSON.parse(readFileSync(file, 'utf8'));
const text = (v, max) => (typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ids = new Set(words.map((w) => w.id));
let added = 0;
let updated = 0;
const skipped = [];

for (const item of incoming) {
  const word = text(item.word, 20);
  const alts = (Array.isArray(item.alternatives) ? item.alternatives : String(item.alternatives || '').split(/[,，、]/)).map((a) => text(a, 20)).filter((a) => a && a !== word);
  if (!word || !alts.length) {
    skipped.push(`${word || '(no word)'}: no word or alternatives`);
    continue;
  }
  const have = words.find((w) => w.word === word);
  if (have) {
    const extra = alts.filter((a) => !have.alternatives.includes(a));
    const fill = ['example', 'trivia'].filter((k) => !have[k] && text(item[k], 200));
    if (!extra.length && !fill.length) continue;
    have.alternatives.push(...extra);
    for (const k of fill) have[k] = text(item[k], 200);
    updated++;
    console.log(`~ ${word}: +${extra.join('、') || '-'}${fill.length ? ` (${fill.join(', ')})` : ''}`);
    continue;
  }
  const category = CATEGORIES.includes(item.category) ? item.category : null;
  const reason = text(item.reason, 300);
  if (!category || !reason) {
    skipped.push(`${word}: needs category (${CATEGORIES.join(' ')}) and reason`);
    continue;
  }
  let id = /^[a-z0-9-]{1,40}$/.test(item.id || '') && !ids.has(item.id) ? item.id : `w${createHash('sha256').update(word).digest('hex').slice(0, 8)}`;
  while (ids.has(id)) id += 'x';
  ids.add(id);
  words.push({ id, word, alternatives: alts, category, reason, example: text(item.example, 200), trivia: text(item.trivia, 200) });
  added++;
  console.log(`+ ${word} (${id}): ${alts.join('、')}`);
}

for (const s of skipped) console.log(`! skipped ${s}`);
console.log(`${added} added, ${updated} updated, ${skipped.length} skipped${dry ? ' (dry run, nothing written)' : ''}`);
if (!dry && (added || updated)) writeFileSync(file, `${JSON.stringify(words, null, 2)}\n`);
