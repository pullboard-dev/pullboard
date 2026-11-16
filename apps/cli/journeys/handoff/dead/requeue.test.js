/** @pullboard-test-input packages/moves/index.js packages/store/index.js */
/** A gate whose worker died is requeued from its captured candidate with no builder resubmit, three times at most [C7,V4]. The move rules are pinned by the generated submit-table cell test (packages/moves/tests/logic/table/submit-generated.test.js); this journey keeps the claim visible at the CLI's level. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardSubmitEngine } from '../../../../../packages/moves/index.js';
import { INFRASTRUCTURE_RETRY_LIMIT } from '../../../../../packages/store/index.js';

test('clause 1: the board allows a dead gate worker three requeues, each a START retry row with no builder command [C7,V4]', () => {
  assert.equal(INFRASTRUCTURE_RETRY_LIMIT, 3);
  const engine = boardSubmitEngine();
  assert.ok(engine.tables.START.outcomes.some(row => row.id === 'retry'), 'START has the retry row that derives the successor job');
  assert.ok(engine.tables.START.outcomes.some(row => row.id === 'spend'), 'START has the spend row that exhausts the budget');
});

test('clause 2: a dead worker ends its job infrastructure, never red, so the item stays claimed and no builder resubmit is needed [C7,V4]', () => {
  const engine = boardSubmitEngine();
  const ids = engine.tables.COMPLETE.outcomes.map(row => row.id);
  assert.ok(ids.includes('infrastructure'), 'COMPLETE records SUBMIT_HANDOFF_DEAD as infrastructure');
  assert.ok(ids.indexOf('infrastructure') < ids.indexOf('red-to-builder'), 'infrastructure is judged before any return to the builder');
});
