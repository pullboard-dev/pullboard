/** Queued submit handoffs recheck their native claimant before a gate slot is admitted [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refused, listResources, submitHandoffClaimProblem, takeResource } from '../apps/lib/index.js';

const now = Date.now();
const request = { item: 17, job: '123e4567-e89b-42d3-a456-426614174000', commit: 'a'.repeat(40) };
const job = { id: request.job, state: 'running', agentId: 'core-17', commit: request.commit, digest: 'b'.repeat(64) };
const item = { item_status: 'claimed', item_owner: job.agentId, item_frozen_digest: job.digest,
  item_lease_until: new Date(now + 60_000).toISOString() };

test('the live queued source remains eligible, while a released or superseded claim drops before slot acquisition [C7]', async t => {
  const machine = mkdtempSync(join(tmpdir(), 'pullboard orphan handoff '));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machine;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(machine, { recursive: true, force: true });
  });
  const attempts = [];
  const admission = current => async () => {
    const problem = submitHandoffClaimProblem(request, current.job, current.item, now);
    attempts.push(problem);
    if (problem) throw new Refused('SUBMIT_HANDOFF_CHANGED', problem);
  };
  const base = { name: 'gate', capacity: 1, scope: 'machine', agent: 'handoff-test', item: String(request.item),
    kind: 'submit', remote: false };

  assert.equal(submitHandoffClaimProblem(request, job, item, now), null, 'the unchanged queued job is still eligible');
  const admitted = await takeResource({ ...base, beforeAdmission: admission({ job, item }) });
  assert.equal(listResources({ scope: 'machine' }).find(row => row.name === 'gate')?.holders.length, 1,
    'a live handoff still acquires the ordinary slot');
  admitted.release();

  const released = { job, item: { ...item, item_status: 'open', item_owner: null } };
  const refrozen = { job, item: { ...item, item_frozen_digest: 'e'.repeat(64) } };
  const superseded = { job: { ...job, commit: 'c'.repeat(40) }, item };
  for (const stale of [released, refrozen, superseded]) {
    await assert.rejects(takeResource({ ...base, agent: `stale-${attempts.length}`, beforeAdmission: admission(stale) }),
      error => error.code === 'SUBMIT_HANDOFF_CHANGED' && error.message.includes('queued submit dropped'));
    const gate = listResources({ scope: 'machine' }).find(row => row.name === 'gate');
    assert.equal(gate?.holders.length ?? 0, 0, 'stale handoff did not take a slot');
    assert.equal(gate?.line.length ?? 0, 0, 'stale handoff leaves no waiter');
  }
  assert.equal(attempts.length, 4, 'one native eligibility check runs for each admission');
  assert.equal(attempts[0], null);
  assert.match(attempts[1], /no longer claimed/u);
  assert.match(attempts[2], /no longer claimed/u);
  assert.match(attempts[3], /original job or captured commit/u);
});
