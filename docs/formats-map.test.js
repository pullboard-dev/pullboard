/** @pullboard-test-input docs/formats.md docs/formats/map.md */
/** @pullboard-world-pin reads docs/formats.md and docs/formats/map.md to compare their section lists. */
/** The format page map lists every top-level section of docs/formats.md once, as a user page or an engine section [C7]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

/** Top-level section titles of docs/formats.md, ignoring fenced code. */
function sections() {
  const out = [];
  let fenced = false;
  for (const line of readFileSync(resolve(ROOT, 'docs/formats.md'), 'utf8').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && line.startsWith('## ')) out.push(line.slice(3).trim());
  }
  return out;
}

/** Map rows as { title, kind, page }. */
function mapRows() {
  return readFileSync(resolve(ROOT, 'docs/formats/map.md'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Section') && !l.startsWith('|---'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([title, kind, page]) => ({ title, kind, page }));
}

test('clause 1: the map lists every top-level section of docs/formats.md exactly once [C7]', () => {
  const titles = mapRows().map((r) => r.title);
  assert.deepEqual([...titles].sort(), [...sections()].sort());
  assert.equal(new Set(titles).size, titles.length, 'no section is listed twice');
});

test('clause 1: each row is a user page or an engine section, and a named user page exists or is planned [C7]', () => {
  for (const { title, kind, page } of mapRows()) {
    assert.ok(kind === 'user' || kind === 'engine', `${title}: kind ${kind}`);
    if (kind === 'engine') {
      assert.equal(page, 'docs/formats.md', title);
      continue;
    }
    const [path, mark] = page.split(' ');
    assert.ok(existsSync(resolve(ROOT, path)) || mark === '(planned)', `${title}: ${path} neither exists nor is planned`);
  }
});
