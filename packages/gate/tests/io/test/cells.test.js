/** The cell-test rule admits the gate heavy door as the gate's second front door, and no other cell's heavy door or gate source file [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellTestProblems } from '../../../src/io/test/cells.js';

const ORDER = new Map([['gate', 1], ['store', 2], ['board', 3]]);
const FILE = 'packages/board/tests/x.test.js';
const importing = target => `import { x } from '../../${target}';\n`;

test('gate.io-test-cells.heavy-door-admitted: clause 1: [C7] cellTestProblems reports no problem for a cell test importing packages/gate/heavy.js below it in plan order, and still reports a gate source file path and another cell heavy.js', () => {
  assert.deepEqual(cellTestProblems(FILE, importing('gate/heavy.js'), { order: ORDER }), []);
  assert.equal(cellTestProblems(FILE, importing('gate/src/io/test/cells.js'), { order: ORDER }).length, 1);
  assert.equal(cellTestProblems(FILE, importing('store/heavy.js'), { order: ORDER }).length, 1);
});

test('gate.io-test-cells.heavy-door-plan-order: clause 1: [C7] a cell test below gate in plan order importing packages/gate/heavy.js is still reported', () => {
  const below = new Map([['board', 1], ['gate', 2]]);
  assert.equal(cellTestProblems(FILE, importing('gate/heavy.js'), { order: below }).length, 1);
});
