/** @pullboard-test-input docs/formats.md docs/formats/* */
/** @pullboard-world-pin reads docs/formats.md, the page map and each user page to compare their text. */
/** Each user page of the formats map exists, holds its section of docs/formats.md unchanged, and stays short [C7]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

/** Sections of docs/formats.md by title, each as its exact text from the heading to the next, ignoring fenced code. */
function sections() {
  const out = new Map();
  let fenced = false;
  let title = null;
  for (const line of readFileSync(resolve(ROOT, 'docs/formats.md'), 'utf8').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) {
      title = line.slice(3).trim();
      out.set(title, [line]);
    } else if (title) out.get(title).push(line);
  }
  return new Map([...out].map(([name, rows]) => [name, rows.join('\n').trim()]));
}

/** User rows of the map as { title, path }, with any planned marker dropped. */
function userPages() {
  return readFileSync(resolve(ROOT, 'docs/formats/map.md'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('| ') && l.includes('| user |'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([title, , page]) => ({ title, path: page.split(' ')[0] }));
}

test('clause 1: each user page named in the map exists under docs/formats [C7]', () => {
  const pages = userPages();
  assert.ok(pages.length > 0, 'the map names user pages');
  for (const { title, path } of pages) {
    assert.match(path, /^docs\/formats\/[a-z-]+\.md$/u, title);
    assert.ok(existsSync(resolve(ROOT, path)), `${title}: ${path} exists`);
  }
});

test('clause 1: each user page holds the text of its section of docs/formats.md unchanged [C7]', () => {
  const all = sections();
  for (const { title, path } of userPages()) {
    assert.ok(all.has(title), `${title} is a section of docs/formats.md`);
    assert.ok(readFileSync(resolve(ROOT, path), 'utf8').includes(all.get(title)), `${path} holds the ${title} section verbatim`);
  }
});

test('clause 1: each user page is under 150 lines [C7]', () => {
  for (const { path } of userPages()) {
    const lines = readFileSync(resolve(ROOT, path), 'utf8').split('\n').length;
    assert.ok(lines < 150, `${path} has ${lines} lines`);
  }
});
