/** A census-filed Main red carries each failing case's full evidence, and a builder's show prints it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sayBrief } from '../../src/io/read.js';
import { failureSignatures } from '../../../../packages/landing/index.js';
import { fileKnownMainReds } from '../../../../packages/landing/src/io/known/main.js';
import * as store from '../../../../packages/store/index.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../packages/store/tests/fixtures/cell.js';

const FILE = 'api/cases.test.js';
const KB = 1024;

/** TAP for one failed assertion whose error text runs past the stack caret, with `padding` extra stderr lines. */
function tap(padding = 0) {
  return `TAP version 13
not ok 1 - case one [C7]
  ---
  duration_ms: 1.5
  location: '/repo/${FILE}:9:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    1 !== 2

        ^
    tail after the caret
${Array.from({ length: padding }, (_, line) => `    padding line ${line} ${'x'.repeat(60)}`).join('\n')}
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 2
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///repo/${FILE}:35:10)
    Test.run (node:internal/test_runner/test:1054:7)
  ...
1..1
# tests 1
# fail 1
`;
}

/** The failure rows a red run of `output` accounts for. */
const rowsOf = output => failureSignatures({ isGreen: false, executionRoot: '/repo', stages: [{ status: 1, output }] }, '/repo', { evidence: true });

/** A real in-memory board with the coordinator seat and one lane that owns the file. */
function fixture(t) {
  const board = openCellBoard(':memory:', { now: () => new Date('2026-11-12T10:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const said = [];
  const state = { board, config: { lanes: { api: { owns: ['api/'] } }, affectedTests: 'node --test' }, say: line => said.push(line),
    batch: { id: 'b1', base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/nowhere', items: [] },
    write: async (operation, args) => store[operation](board, ...args) };
  return { board, state, said };
}

test('clause 1: a filed main red records the assertion line, expected and actual and stderr past the caret [C7]', async (t) => {
  const { board, state } = fixture(t);
  const rows = rowsOf(tap());
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].evidence.location, `${FILE}:35`);
  assert.equal(rows[0].evidence.expected, '2');
  assert.equal(rows[0].evidence.actual, '1');
  assert.match(rows[0].evidence.stderr, /tail after the caret/u, 'the stderr is not cut at the stack caret');

  await fileKnownMainReds(state, rows);
  const [item] = store.listItems(board, { all: true }).filter(row => row.item_title === `Main red: ${FILE}`);
  assert.match(item.item_brief, new RegExp(`at ${FILE}:35`, 'u'));
  assert.match(item.item_brief, /expected: 2/u);
  assert.match(item.item_brief, /actual: 1/u);
  assert.match(item.item_brief, /tail after the caret/u);
});

test('clause 1: the stderr kept per case is cut at 4 KB, and only there [C7]', () => {
  const rows = rowsOf(tap(200));
  assert.equal(rows[0].evidence.stderr.length, 4 * KB);
  assert.match(rows[0].evidence.stderr, /tail after the caret/u);
});

test('clause 2: a builder\'s show of the filed item prints that evidence [C7]', async (t) => {
  const { board, state } = fixture(t);
  await fileKnownMainReds(state, rowsOf(tap()));
  const [item] = store.listItems(board, { all: true }).filter(row => row.item_title === `Main red: ${FILE}`);
  const lines = [];
  sayBrief({ say: line => lines.push(line) }, item.item_brief);
  const shown = lines.join('\n');
  assert.match(shown, new RegExp(`at ${FILE}:35`, 'u'));
  assert.match(shown, /expected: 2/u);
  assert.match(shown, /actual: 1/u);
  assert.match(shown, /tail after the caret/u);
});
