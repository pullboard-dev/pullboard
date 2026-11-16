/** With claim.keepWhileRunning on, a claim whose holder has a test run, test or gate job in flight is not returned as idle; off, or with nothing in flight, it is [C7,#9498]. */
/** @pullboard-test-input source-cell store board health config */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { addItem } from '../../../../../store/index.js';
import { claim } from '../../../../../store/index.js';
import { logEvent } from '../../../../../store/index.js';
import { register } from '../../../../../store/index.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { captureLapsedClaims } from '../../../../index.js';
import { MACHINE_DEFAULTS } from '../../../../../config/src/io/settings/machine-defaults.js';

const MINUTE = 60_000;

/** A real board: a seat claimed 3 hours ago, its lease lapsed 50 minutes ago, heartbeating now, and a helper seat to run the capture. */
function fixture(t) {
  const { root } = privateFixtureFiles('pullboard-keep-run-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now() - 180 * MINUTE;
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  register(board, { lane: 'coordinator', path: join(root, 'coordinator') });
  mkdirSync(join(root, 'seat'));
  const holder = register(board, { lane: 'core', path: join(root, 'seat'), route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Work', criterion: 'Work' });
  claim(board, id, { agentId: holder, lane: 'core', leaseMs: 130 * MINUTE, freeze: () => ({ text: 'Work', digest: 'bar' }) });
  const helper = register(board, { lane: 'core', path: join(root, 'helper'), route: 'strong' });
  now = Date.now();
  logEvent(board, holder, 'heartbeat', id, {});
  const job = ({ kind, step, owner = null, leaseUntil = 0, createdAgo = 5 * MINUTE, agent = null }) => {
    const jobId = `${kind}:${id}:${step}:${owner ?? 'none'}:${createdAgo}`;
    const created = now - createdAgo;
    board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, kind, id, step, owner, leaseUntil, created, created);
    if (agent) board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'queued', ?, ?)").run(jobId, JSON.stringify({ agent, files: ['a.test.js'] }), created);
  };
  const returned = keep => (captureLapsedClaims({ clock: { now: () => new Date(now) }, config: {}, keepClaimWhileRunning: keep }, board, helper)?.claims ?? []).map(row => row.id);
  return { id, holder, job, returned, now: () => now };
}

test('clause 1: with claim.keepWhileRunning on, a claim past the idle release with a live test-run, test or gate job on its item is not returned [C7,#9498]', t => {
  const f = fixture(t);
  assert.deepEqual(f.returned(true), [f.id], 'with nothing in flight the idle claim is returned, setting on or not');
  f.job({ kind: 'test-run', step: 'queued', agent: f.holder });
  assert.deepEqual(f.returned(true), [], 'a test run its holder queued keeps the claim');
  const g = fixture(t);
  g.job({ kind: 'test', step: 'claimed', owner: 'runner-1', leaseUntil: g.now() + 2 * MINUTE });
  assert.deepEqual(g.returned(true), [], 'a test job under a live lease keeps the claim');
  const h = fixture(t);
  h.job({ kind: 'gate', step: 'claimed', owner: 'runner-1', leaseUntil: h.now() + 2 * MINUTE });
  assert.deepEqual(h.returned(true), [], 'a gate job under a live lease keeps the claim');
});

test('clause 2: with claim.keepWhileRunning at its default (off) the same claim is returned as today, and a claim with no job in flight is still returned with it on [C7,#9498]', t => {
  assert.equal(MACHINE_DEFAULTS['claim.keepWhileRunning'], false);
  const f = fixture(t);
  f.job({ kind: 'test-run', step: 'queued', agent: f.holder });
  assert.deepEqual(f.returned(false), [f.id], 'off: the live run does not keep an idle claim');
  const g = fixture(t);
  g.job({ kind: 'test', step: 'claimed', owner: 'runner-dead', leaseUntil: g.now() - MINUTE });
  g.job({ kind: 'test-run', step: 'done', agent: g.holder });
  assert.deepEqual(g.returned(true), [g.id], 'on: only a lapsed or finished job is nothing in flight');
});
