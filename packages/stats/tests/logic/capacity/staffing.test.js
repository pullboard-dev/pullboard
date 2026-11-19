/** The board computes the builder and review seats to run, 8 builders to 1 reviewer by default [C7,#11832]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffingLines } from '../../../src/logic/capacity/staffing.js';
import { staffingSeats } from '../../../src/logic/capacity/staffing.js';
import * as light from '../../../light.js';

test('stats.logic-capacity-staffing.counts: clause 1: staffingSeats caps builders at the max useful when known and gives one reviewer per 8 builders, at least 1 when any builder runs [C7,#11832]', () => {
  assert.deepEqual(staffingSeats({ ready: 8 }), { builders: 8, reviewers: 1, ratio: 8 });
  assert.equal(staffingSeats({ ready: 9 }).reviewers, 2);
  assert.deepEqual(staffingSeats({ ready: 0 }), { builders: 0, reviewers: 0, ratio: 8 });
  assert.equal(staffingSeats({ ready: 1 }).reviewers, 1);
  assert.equal(staffingSeats({ ready: 20, maxUseful: 5 }).builders, 5);
  assert.equal(staffingSeats({ ready: 3, maxUseful: 5 }).builders, 3);
  assert.equal(staffingSeats({ ready: 20, maxUseful: null }).builders, 20);
  assert.equal(staffingSeats({ ready: 16, ratio: 4 }).reviewers, 4);
});

test('stats.logic-capacity-staffing.line: clause 2: staffingLines prints one line naming the builder seats, the review seats and the ratio [C7,#11832]', () => {
  assert.equal(staffingLines(staffingSeats({ ready: 8 })), 'Staffing: 8 builders, 1 reviewer (8:1)');
  assert.equal(staffingLines(staffingSeats({ ready: 9 })), 'Staffing: 9 builders, 2 reviewers (8:1)');
});

test('stats.logic-capacity-staffing.exported: clause 3: staffingSeats and staffingLines are both exported through the light door and answer as the staffing file does [C7,#11832]', async () => {
  assert.deepEqual(await light.staffingSeats({ ready: 9 }), staffingSeats({ ready: 9 }));
  assert.equal(await light.staffingLines(staffingSeats({ ready: 8 })), 'Staffing: 8 builders, 1 reviewer (8:1)');
});
