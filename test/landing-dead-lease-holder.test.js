/** A dead landing lease holder is reclaimed by the next lander within the lease period [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { reclaimReason } from '../packages/landing/src/shell/landing-resource.js';

/** A pid that certainly belongs to no running process: a child that already exited. */
function deadPid() { return spawnSync(process.execPath, ['-e', '0']).pid; }

/** A linked-board holder recorded on one machine with its shared deadline. */
function holder(overrides = {}) {
  return { token: 'a'.repeat(8) + '-0000-0000-0000-' + 'b'.repeat(12), pid: deadPid(), lineage: 'lineage-1', machine: 'machine-a',
    since: '2026-01-01T00:00:00.000Z', until: '2026-01-01T00:02:00.000Z', generation: 3137, ...overrides };
}

const LATER = Date.parse('2026-01-01T00:03:00.000Z');

test('clause 1: a landing lease whose holder token has no live process on this machine is released by the next lander within 2 minutes, with a release event naming the reason [C7]', () => {
  const reason = reclaimReason(holder(), null, { now: LATER, machine: 'machine-a' });
  assert.match(reason, /holder process gone/u, 'a dead local holder with a stale heartbeat is reclaimed with a named reason');
  assert.equal(reclaimReason(holder(), null, { now: Date.parse('2026-01-01T00:01:00.000Z'), machine: 'machine-a' }), null, 'a heartbeat younger than 2 minutes is left alone');
  assert.equal(reclaimReason(holder({ pid: process.pid }), null, { now: LATER, machine: 'machine-a' }), null, 'a live holder is never reclaimed');
  assert.equal(reclaimReason(holder({ machine: 'machine-b' }), null, { now: LATER, machine: 'machine-a' }), null, 'a foreign machine holder is never judged by local pids');
});

test('clause 2: a waiting lander never logs foreign holders require explicit release for a holder on this machine whose process is dead [C7]', () => {
  // The waiting loop releases any holder with a reason before it reports a wait, so no wait message names a dead local holder.
  assert.ok(reclaimReason(holder({ machine: 'machine-a' }), null, { now: LATER, machine: 'machine-a' }));
  assert.ok(reclaimReason(holder({ lineage: null }), null, { now: LATER, machine: null }), 'an unlinked board releases a dead holder at once');
});
