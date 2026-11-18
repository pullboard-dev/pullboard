/** @pullboard-test-input packages/gate/src/logic/test/manifest.js */
/** The journey cut keeps at most two journeys per golden path and says why each was chosen [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEP_PER_PATH } from '../../../src/logic/test/manifest.js';
import { manifestRows } from '../../../src/logic/test/manifest.js';
import { tagJourneys } from '../../../src/logic/test/manifest.js';

const journey = (file, specs, ms = null) => ({ file, kind: 'journey', specs, cost: { ms } });
const cell = specs => ({ file: 'packages/a/tests/cell.test.js', kind: 'cell unit', specs, cost: { ms: 1 } });
const tags = rows => Object.fromEntries(rows.filter(row => row.tag).map(row => [row.file.split('/').slice(-2).join('/'), row.tag]));

const PATHS = ['init', 'add', 'next', 'submit', 'verify', 'land', 'release', 'upgrade'];

test('clause 1: a golden path keeps at most two journeys and the rest convert or delete [C7]', () => {
  const rows = tagJourneys(PATHS.flatMap(path => [1, 2, 3, 4].map(n => journey(`apps/cli/journeys/${path}/j${n}.test.js`, [`S${n}`]))));
  for (const path of PATHS) {
    const kept = rows.filter(row => row.file.includes(`/${path}/`) && row.tag === 'keep');
    assert.equal(kept.length, KEEP_PER_PATH, path);
  }
  assert.equal(rows.filter(row => row.tag === 'keep').length, PATHS.length * KEEP_PER_PATH);
  assert.equal(rows.filter(row => row.tag !== 'keep').every(row => ['convert', 'delete'].includes(row.tag)), true);
});

test('the journeys that cite the most spec ids are kept, then the fastest [C7]', () => {
  const rows = tagJourneys([
    journey('apps/cli/journeys/add/few.test.js', ['A1']),
    journey('apps/cli/journeys/add/most.test.js', ['A1', 'A2', 'A3']),
    journey('apps/cli/journeys/add/slow.test.js', ['A1', 'A2'], 9000),
    journey('apps/cli/journeys/add/fast.test.js', ['A1', 'A2'], 400),
  ]);
  assert.deepEqual(tags(rows), { 'add/few.test.js': 'convert', 'add/most.test.js': 'keep', 'add/slow.test.js': 'convert', 'add/fast.test.js': 'keep' });
});

test('a journey with a recorded runtime beats one with none when spec counts tie [C7]', () => {
  const rows = tagJourneys([journey('apps/cli/journeys/next/a.test.js', ['N1']), journey('apps/cli/journeys/next/b.test.js', ['N1'], 50), journey('apps/cli/journeys/next/c.test.js', ['N1'], 60)]);
  assert.deepEqual(tags(rows), { 'next/a.test.js': 'convert', 'next/b.test.js': 'keep', 'next/c.test.js': 'keep' });
});

test('each kept row names why it was chosen over the others on its path [C7]', () => {
  const rows = tagJourneys([journey('apps/cli/journeys/land/a.test.js', ['L1', 'L2'], 120), journey('apps/cli/journeys/land/b.test.js', ['L1']), journey('apps/cli/journeys/land/c.test.js', ['L1'])]);
  const kept = rows.find(row => row.file.endsWith('land/a.test.js'));
  assert.equal(kept.tag, 'keep');
  assert.match(kept.tagBecause, /golden path land; chosen over 2 others on it: rank 1 of 3 by 2 spec ids, then speed \(120 ms\)/u);
  assert.match(rows.find(row => row.file.endsWith('land/b.test.js')).tagBecause, /no recorded runtime/u);
});

test('a journey that loses its path falls to the delete rule when a cell cites its ids, else convert [C7]', () => {
  const rows = tagJourneys([
    cell(['X1']),
    journey('apps/cli/journeys/verify/a.test.js', ['V1', 'V2', 'V3']),
    journey('apps/cli/journeys/verify/b.test.js', ['V1', 'V2']),
    journey('apps/cli/journeys/verify/c.test.js', ['X1']),
    journey('apps/cli/journeys/verify/d.test.js', ['Z9']),
  ]);
  assert.deepEqual(tags(rows), { 'verify/a.test.js': 'keep', 'verify/b.test.js': 'keep', 'verify/c.test.js': 'delete', 'verify/d.test.js': 'convert' });
});

test('clause 2: relay pair and view open count as paths and every path holds two at most, so the keep count never passes the path count times two [C7]', () => {
  const files = [...PATHS.map(path => `apps/cli/journeys/${path}`), 'apps/cli/journeys/relay/pair', 'apps/cli/journeys/view/open'];
  const rows = tagJourneys(files.flatMap(base => [1, 2, 3].map(n => journey(`${base}/j${n}.test.js`, [`K${n}`]))));
  assert.equal(rows.filter(row => row.tag === 'keep').length, files.length * KEEP_PER_PATH);
});

test('a file the golden registry names stays harness and untagged when the manifest is regenerated [C7]', () => {
  const spawns = { direct: new Set(['process']), via: new Map() };
  const rows = manifestRows([{ file: 'apps/cli/journeys/add/brief.test.js', ms: null, specs: ['C7'], ...spawns }, { file: 'apps/cli/journeys/add/other.test.js', ms: null, specs: ['C7'], ...spawns }], new Set(['apps/cli/journeys/add/brief.test.js']));
  assert.equal(rows[0].kind, 'harness');
  assert.equal(rows[0].tag, undefined);
  assert.equal(rows[1].kind, 'journey');
});
