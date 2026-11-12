/**
 * Design contract (#6365, #6293, #6294): the plan-placement check is dropped, not replaced. requirePlannedSource has no
 * successor; composition and size checks stay. The CLI children (#6368) remove its callers. [C7]
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import * as items from '../../../index.js';

/** Callers the CLI children must change: submit.js (three calls, #6368) and the gate.js placement step (#6368). */
const CALLERS = [
  { file: 'apps/cli/src/io/commands/submit.js', calls: 3, child: '#6368' },
  { file: 'apps/cli/src/io/submit/gate.js', calls: 1, child: '#6368' },
];

test('packages/items exports no requirePlannedSource [C7]', () => {
  assert.equal('requirePlannedSource' in items, false, 'placement has no replacement; do not re-add it');
});

test('submitPreflight on a fixture without the cells plan passes with no CELLS_PLAN_UNPLACED refusal [C7]', () => {
  const board = { db: { prepare: () => ({ get: () => ({}) }) } };
  const ran = [];
  assert.doesNotThrow(() => items.submitPreflight(board, 1, { agentId: 'a', commit: 'c'.repeat(40), tree: 't'.repeat(40) },
    { atomic: (_board, run) => run(), submit: () => ran.push('submit'), prepareSubmit: undefined }));
  assert.deepEqual(ran, ['submit']);
});

test('the callers the CLI children must change are named [C7]', () => {
  const root = new URL('../../../../../', import.meta.url);
  for (const caller of CALLERS) {
    assert.equal(existsSync(new URL(caller.file, root)), true, `${caller.file} (${caller.child}) must exist to be changed`);
  }
  assert.equal(CALLERS.reduce((sum, row) => sum + row.calls, 0), 4);
});
