/** The compatibility page's cells group conformance rows by stage, each outcome one of five words with its run id [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conformanceResults } from '../../../../../packages/gate/index.js';
import { COMPAT_STAGES } from '../../../src/logic/cockpit/compat.js';
import { COMPAT_OUTCOMES } from '../../../src/logic/cockpit/compat.js';
import { compatCells } from '../../../src/logic/cockpit/compat.js';

const CONFORMANCE_STAGES = conformanceResults([{ language: 'node', toolchains: [] }], [], () => true).map((row) => row.stage);

test('view.logic-cockpit-compat.cells: clause 1: compatCells turns conformance rows into cells of works, partial, breaks, unavailable or unknown with the run id, grouped by stage in CONFORMANCE_STAGES order [C7]', () => {
  assert.deepEqual([...COMPAT_STAGES], [...CONFORMANCE_STAGES], 'the page order is the gate order');
  const rows = [
    { language: 'node', stage: 'land', outcome: 'unknown', run: null },
    { language: 'node', stage: 'claim', outcome: 'works', run: 'run-1' },
    { language: 'go', stage: 'claim', outcome: 'unavailable', run: null },
    { language: 'rust', stage: 'claim', outcome: 'red', run: 'run-2' },
    { language: 'python', stage: 'claim', outcome: 'partial', run: 'run-3' },
    { language: 'ruby', stage: 'claim', outcome: 'surprising', run: 'run-4' },
  ];
  const groups = compatCells(rows);
  assert.deepEqual(groups.map((group) => group.stage), [...CONFORMANCE_STAGES], 'one group per stage in the gate order');
  const claim = groups[0].cells;
  assert.deepEqual(claim, [
    { language: 'node', outcome: 'works', run: 'run-1' },
    { language: 'go', outcome: 'unavailable', run: null },
    { language: 'rust', outcome: 'breaks', run: 'run-2' },
    { language: 'python', outcome: 'partial', run: 'run-3' },
    { language: 'ruby', outcome: 'unknown', run: 'run-4' },
  ]);
  assert.deepEqual(groups.at(-1).cells, [{ language: 'node', outcome: 'unknown', run: null }]);
  for (const group of groups) for (const cell of group.cells) {
    assert.ok(COMPAT_OUTCOMES.includes(cell.outcome), 'only the five outcome words');
    assert.deepEqual(Object.keys(cell).sort(), ['language', 'outcome', 'run'], 'no literal cell text');
  }
  assert.deepEqual(compatCells([]).map((group) => group.cells.length), [0, 0, 0, 0, 0, 0]);
});
