/** The board-writer check: board writes outside the sequencer folder are refused past a per-file ceiling that only falls [CD2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATIC_CHECKS } from '../../src/io/static/check/registry.js';
import { STORE_REGISTRY } from '../../src/io/stores.js';
import { BOARD_WRITER_BASELINE } from '../../src/io/board-writers.js';
import { boardWriterBaselineGrowth } from '../../src/io/board-writers.js';

const STRAY = 'packages/gate/src/io/stray.js';
const INSIDE = 'packages/store/src/io/board/write/sequencer.js';
const REGISTRY = STORE_REGISTRY;
const STORES = JSON.stringify({ stores: { 'table:item': { kind: 'table', owner: INSIDE } } });

/** Run the registered check on candidate files with a baseline, and main's baseline as `accepted`. */
function judge(files, { baseline = {}, accepted = null } = {}) {
  const tree = { [REGISTRY]: STORES, [BOARD_WRITER_BASELINE]: JSON.stringify(baseline), ...files };
  const check = STATIC_CHECKS.find(row => row.name === 'board-write-outside-sequencer');
  return check.run({
    files: Object.keys(files),
    sources: Object.entries(files).filter(([file]) => file.endsWith('.js')).map(([file, source]) => ({ file, source })),
    text: file => tree[file],
    previous: file => (file === BOARD_WRITER_BASELINE && accepted ? JSON.stringify(accepted) : ''),
  });
}

test('gate.io-board-writers.refuses-stray-write: clause 1: a board write outside the sequencer folder is refused with the rule, file and line [C7]', () => {
  const source = [
    "const a = 1;",
    "db.exec('BEGIN IMMEDIATE');",
    "db.prepare('UPDATE item SET item_status = ?').run('x');",
    "db.prepare('DELETE FROM item WHERE item_id = ?');",
    "const file = 'board.sqlite';",
    "const w = new DatabaseSync(file);",
    "const r = new DatabaseSync(file, { readOnly: true });",
  ].join('\n');
  const failures = judge({ [STRAY]: source });
  assert.deepEqual(failures.map(row => row.split(': ')[0]), [`${STRAY}:2`, `${STRAY}:3`, `${STRAY}:4`, `${STRAY}:6`]);
  assert.ok(failures.every(row => row.includes('board-write-outside-sequencer')));
  assert.deepEqual(judge({ [INSIDE]: source }), [], 'the sequencer folder may write');
  assert.deepEqual(judge({ [STRAY]: "db.prepare('SELECT * FROM item');" }), []);
});

test('gate.io-board-writers.baseline-only-shrinks: clause 2: a new site or a raised count fails, a lowered count passes [C7]', () => {
  const one = "db.exec('BEGIN IMMEDIATE');";
  assert.equal(judge({ [STRAY]: one }, { baseline: { [STRAY]: 1 } }).length, 0, 'a counted site passes');
  assert.equal(judge({ [STRAY]: `${one}\n${one}` }, { baseline: { [STRAY]: 1 } }).length, 1, 'a new site fails');
  assert.equal(judge({ [STRAY]: one }, { baseline: {} }).length, 1, 'a file with no row fails');
  assert.equal(boardWriterBaselineGrowth({ [STRAY]: 2 }, { [STRAY]: 1 }).length, 1);
  assert.equal(boardWriterBaselineGrowth({ [STRAY]: 1 }, { [STRAY]: 2 }).length, 0);
  assert.equal(judge({ [BOARD_WRITER_BASELINE]: '' }, { baseline: { [STRAY]: 2 }, accepted: { [STRAY]: 1 } }).length, 1, 'a raised count fails');
  assert.equal(judge({ [BOARD_WRITER_BASELINE]: '' }, { baseline: { [STRAY]: 1 }, accepted: { [STRAY]: 2 } }).length, 0, 'a lowered count passes');
});

test('gate.io-board-writers.registered: clause 3: the static check registry runs board-write-outside-sequencer [C7]', () => {
  assert.equal(STATIC_CHECKS.filter(row => row.name === 'board-write-outside-sequencer').length, 1);
});
