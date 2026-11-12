/** The search cell indexes item title, criterion and brief from a real SQLite board; its sidecar is derived and rebuildable [C7]. */
/** @pullboard-world-pin: clause 3 reads every tracked source file to prove no other cell imports packages/search. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { addItem } from '../../../store/index.js';
import { fixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../../apps/cli/tests/fixtures/board.js';
import { buildSearchIndex } from '../../index.js';
import { readSearchIndex } from '../../index.js';
import { searchItems } from '../../index.js';

/** The two command files that may use the search cell: search prints matches, add prints advice. */
const COMMANDS = ['apps/cli/src/io/commands/search.js', 'apps/cli/src/io/commands/add.js'];
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** A board with items whose words sit in different fields, plus a temporary sidecar path. */
function seeded(t) {
  const board = fixtureBoard(t);
  const add = fields => addItem(board, { by: 'coordinator', lane: 'core', ...fields });
  const ids = {
    title: add({ title: 'Landing queue stalls when the runner quarantine fills' }),
    criterion: add({ title: 'Speed up a slow command', criterion: '1. The sidecar of the TF-IDF search index rebuilds from the board [test].' }),
    brief: add({ title: 'Tidy the cockpit header', brief: 'Gradient backdrop removed; header shows the lane name in plain type.' }),
    other: add({ title: 'Relay reconnects after a laptop sleeps', criterion: '1. The relay link survives sleep [test].' }),
  };
  const directory = temporaryDirectory('pullboard-search-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { board, ids, sidecar: join(directory, 'search', 'index.json') };
}

test('the search cell builds a TF-IDF index over item title, criterion and brief from the board [C7]', t => {
  const { board, ids, sidecar } = seeded(t);
  const index = buildSearchIndex(board, { sidecar });
  assert.deepEqual([...index.ids].sort((a, b) => a - b), Object.values(ids).sort((a, b) => a - b));
  assert.ok(existsSync(sidecar));
  assert.equal(searchItems(board, 'runner quarantine stalls the landing queue', { sidecar })[0].id, ids.title);
  assert.equal(searchItems(board, 'rebuild the search index sidecar', { sidecar })[0].id, ids.criterion);
  assert.equal(searchItems(board, 'cockpit gradient backdrop', { sidecar })[0].id, ids.brief);
  assert.deepEqual(searchItems(board, 'zebra', { sidecar }), []);
  assert.ok(!searchItems(board, 'runner quarantine', { sidecar, exclude: [ids.title] }).some(hit => hit.id === ids.title));
});

test('deleting the sidecar and rebuilding from the board gives the same ranking [C7]', t => {
  const { board, ids, sidecar } = seeded(t);
  const queries = ['runner quarantine stalls the landing queue', 'search index sidecar rebuilds', 'relay sleep link', 'lane header'];
  buildSearchIndex(board, { sidecar });
  const bytes = readFileSync(sidecar, 'utf8');
  const before = queries.map(query => searchItems(board, query, { sidecar, limit: 10 }));
  rmSync(sidecar);
  assert.equal(readSearchIndex(sidecar), null);
  const rebuilt = queries.map(query => searchItems(board, query, { sidecar, limit: 10 }));
  assert.ok(existsSync(sidecar), 'a search with no sidecar rebuilds it from the board');
  assert.equal(readFileSync(sidecar, 'utf8'), bytes);
  assert.deepEqual(rebuilt, before);
  assert.ok(before.every(hits => hits.length > 0));
  // A board change makes the stored sidecar stale, so the next search rebuilds and finds the new item.
  const added = addItem(board, { by: 'coordinator', lane: 'core', title: 'Quarantine runner drain' });
  assert.ok(searchItems(board, 'quarantine runner drain', { sidecar }).some(hit => hit.id === added));
  assert.ok(readSearchIndex(sidecar).ids.includes(added));
});

test('only the search and add commands import the search cell [C7]', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs', '*.cjs'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const importers = [];
  for (const file of files) {
    if (file.startsWith('packages/search/')) continue;
    const source = readFileSync(join(ROOT, file), 'utf8');
    if (!source.includes('search')) continue;
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
      if (target === 'packages/search' || target.startsWith('packages/search/')) importers.push(`${file} -> ${match[1]}`);
    }
  }
  assert.deepEqual(importers.map(entry => entry.split(' -> ')[0]).filter(file => !COMMANDS.includes(file)), []);
});
