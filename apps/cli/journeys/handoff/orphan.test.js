/** Queued submit handoffs recheck their native claimant before a gate slot is admitted [C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Refused,
  listResources,
  nativeBoardPorts,
  openBoard,
  openBoardForRead,
  takeResource,
} from '../../../lib/index.js';
import {
  submitHandoffClaimProblem,
  assertCurrentSubmitHandoff,
} from '../../index.js';
import { cliContext$context as context } from '../../index.js';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

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

test('the real worker guard records one terminal stale result after a waiting handoff loses its claim [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'handoff-guard-fixture';
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = sandbox.env.PULLBOARD_MACHINE_HOME;
  t.after(() => {
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  });
  const box = helpers.project('true', sandbox);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Native queued handoff', '--specs', 'G1', '--criterion',
    'A stale queued handoff is dropped before runner admission. [test]', '--check', 'true', '--brief', 'Files:\n- web/page.js\nTest:\n- the check passes', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(boardFile, undefined, { gitRoot: box.web });
  try {
    const item = store.getItem(board, id);
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    const queued = store.queueSubmitHandoff(board, id, { agentId: item.item_owner, job: randomUUID(),
      main: box.git(box.web, 'rev-parse', 'main'), commit, tree, executionCommit: commit, executionTree: tree,
      digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 });
    store.startSubmitHandoff(board, id, { agentId: item.item_owner, job: queued.job.id });
    const request = { item: id, job: queued.job.id, commit };
    const nativeBoard = { openBoard, openBoardForRead, nativeBoardPorts };
    const ctx = context({ cwd: box.web, nativeBoard, relayJson: true, say() {}, err() {} });
    const waitingGate = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'occupying-runner',
      item: String(id), kind: 'submit', remote: false });
    let renewed = 0;
    const waiting = takeResource({ name: 'gate', capacity: 1, scope: 'machine', agent: 'queued-worker',
      item: String(id), kind: 'submit', remote: false,
      beforeAdmission: () => assertCurrentSubmitHandoff(ctx, request),
      onWait: async () => {
        renewed++;
        return {};
      } });
    const rejected = assert.rejects(waiting, { code: 'SUBMIT_HANDOFF_CHANGED' });
    t.after(() => waitingGate.release());
    try {
      await helpers.waitFor(() => listResources({ scope: 'machine' }).find(row => row.name === 'gate')
        ?.line.some(waiter => waiter.agent === 'queued-worker'), 'queued native worker at gate admission');
      store.release(board, id, item.item_owner, 'fixture released while queued', undefined, 'OTHER');
    } finally { waitingGate.release(); }
    await rejected;
    assert.equal(renewed, 1, 'the native worker rechecks before a second lease renewal after losing its claim');
    assert.equal(listResources({ scope: 'machine' }).find(row => row.name === 'gate')?.holders.length ?? 0, 0,
      'the stale worker did not acquire the released slot');
    assert.throws(() => assertCurrentSubmitHandoff(ctx, request), { code: 'SUBMIT_HANDOFF_CHANGED' });
    const error = { code: 'SUBMIT_HANDOFF_CHANGED', message: 'queued submit dropped after its native claim changed', next: 'Claim the item again before submitting.' };
    store.completeSubmitHandoff(board, id, { agentId: item.item_owner, job: queued.job.id, result: { code: 1, error } });
    const terminal = store.submitHandoff(board, id);
    assert.equal(terminal.state, 'red');
    assert.equal(terminal.error.code, 'SUBMIT_HANDOFF_CHANGED');
    const drops = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit-handoff'").all(id)
      .map(row => JSON.parse(row.event_detail)).filter(detail => detail.state === 'red').length;
    assert.equal(drops, 1, 'the stale native job has exactly one recorded terminal drop');
  } finally { board.db.close(); }
});
