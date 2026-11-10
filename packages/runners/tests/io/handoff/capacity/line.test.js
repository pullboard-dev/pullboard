/** Status shows the dispatcher's live worker cap and where it came from; an inherited cap never lowers it [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { currentCapacity } from '../../../../index.js';
import { liveCapacity } from '../../../../index.js';
import { handoffCapLine } from '../../../../../resources/index.js';
import { handoffWorkerCapacityDetail } from '../../../../../resources/index.js';

/** The dispatcher's bound on workers (DISPATCH_WORKER_BOUND in the resources cell): the contract, asserted by value. */
const DISPATCH_WORKER_BOUND = 16;

/** Run work with the machine home pointed at a fresh folder and an inherited cap of 1. */
function withMachine(work) {
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, cap: process.env.PULLBOARD_HANDOFF_WORKERS };
  process.env.PULLBOARD_MACHINE_HOME = privateFixtureFiles('handoff-cap-status-').root;
  process.env.PULLBOARD_HANDOFF_WORKERS = '1';
  try { return work(); } finally {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['PULLBOARD_HANDOFF_WORKERS', saved.cap]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('clause 1: a dispatcher launched with PULLBOARD_HANDOFF_WORKERS=1 in its environment runs the computed default, and only the machine setting lowers it [C7]', () => {
  withMachine(() => {
    assert.notEqual(currentCapacity(), 1, 'the inherited override is ignored');
    assert.equal(currentCapacity({ PULLBOARD_HANDOFF_WORKERS: '3' }), 3, 'an explicit machine override still lowers it');
  });
});

test('clause 2: status shows the dispatcher live worker cap and where it came from [C7]', () => {
  withMachine(() => {
    assert.equal(handoffCapLine(), null, 'no dispatcher has run yet');
    const live = liveCapacity();
    assert.match(handoffCapLine(), new RegExp(`^handoff workers: cap ${live} \\(.+\\)$`, 'u'));
    assert.deepEqual(handoffWorkerCapacityDetail({ env: {}, cores: 8, runnerSlots: 66, runnersOnly: true }), { cap: DISPATCH_WORKER_BOUND, source: `every runner slot (66, gate.runnersOnly), bounded at ${DISPATCH_WORKER_BOUND}` });
    assert.equal(liveCapacity({ PULLBOARD_HANDOFF_WORKERS: '3' }), 3);
    assert.equal(handoffCapLine(), 'handoff workers: cap 3 (PULLBOARD_HANDOFF_WORKERS override)', 'a changed cap replaces the record');
  });
});

test('clause 1: the gate.handoffWorkers machine setting lowers the live cap with no environment override, and an inherited one still does not [C7]', () => {
  withMachine(() => {
    const before = process.env.PULLBOARD_HANDOFF_WORKERS;
    delete process.env.PULLBOARD_HANDOFF_WORKERS;
    try {
      writeFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gate: { handoffWorkers: 2 } }));
      assert.equal(liveCapacity(), 2, 'the machine setting lowers the cap');
      assert.equal(handoffCapLine(), 'handoff workers: cap 2 (gate.handoffWorkers machine setting)');
    } finally { process.env.PULLBOARD_HANDOFF_WORKERS = before; }
  });
});
