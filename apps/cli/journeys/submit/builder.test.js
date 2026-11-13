/** A refused queued gate's red lines name the exact cause first [V4,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queuedRedLines } from '../../../../packages/store/index.js';

test('the red lines carry a refusal naming a file and line verbatim (clause 1) [V4,N2,C7]', () => {
  const error = { code: 'CELLS_SUBMIT', message: 'web/page.js:12: added import through compatibility shim src/board.js; import from packages/store/index.js instead',
    next: 'import from the cell front door, commit, then submit again' };
  assert.deepEqual(queuedRedLines([{ id: 7, title: 'Page', leaseUntil: '2026-11-02T12:00:00.000Z', error }], Date.parse('2026-11-02T11:00:00.000Z')), [
    `red queued gate on #7 Page: CELLS_SUBMIT: ${error.message}`,
    `next: ${error.next}`,
    '#7 stays claimed by you until 2026-11-02T12:00:00.000Z; fix it, commit, then pullboard submit 7',
  ]);
});
