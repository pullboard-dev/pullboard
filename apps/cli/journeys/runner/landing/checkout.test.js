/** A land job into a trunk remote that is a non-bare checkout with main checked out updates it in place; a bare trunk lands as before [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';
import { context } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
import { wakeIo } from '../../../src/io/landing/automatic.js';
import { trunkCheckedOut } from '../../../src/io/landing/checkout.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';
import { acceptGated } from '../../../tests/fixtures/pull.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

/**
 * Name a trunk remote of record (a bare clone, or a plain clone with main checked out), gate and accept one item, let
 * the automatic lander offer its land job, and run that job's own payload as a runner would; return what it saw. dirty:
 * leave an uncommitted edit in the checked-out trunk first.
 */
async function landInto(t, { bare, dirty = false }) {
  const box = await pullProject(t, 1);
  const trunk = join(box.dir, bare ? 'trunk.git' : 'trunk');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false }, trunk: { remote: trunk } }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: name the trunk remote of record [G1]');
  box.git(box.dir, 'clone', '-q', ...(bare ? ['--bare'] : []), box.repo, trunk);
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  assert.equal((await serveOnce(box, queue.url, 'r-gate')).code, 0);
  acceptGated(queue.board, box.repo, id, commit);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false } });
  const run = await captureCommandInProcess(() => landAfterAcceptance(context(wakeIo(box.repo))).then(() => 0), [], { cwd: box.repo, env: { ...box.env } });
  assert.equal(run.code, 0, run.err);
  const jobs = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(jobs.length, 1, 'accept offered one land job');
  const { payload } = jobs[0].steps.find(step => step.name === 'offered').payload;
  if (dirty) { writeFileSync(join(trunk, 'host-edit.txt'), 'an edit the person has not committed\n'); box.git(trunk, 'add', 'host-edit.txt'); }
  const receipt = await runLandingJob(payload, { workdir: join(box.dir, 'land'), checks: () => ({ ok: true }) });
  const tip = box.git(box.dir, '--git-dir', bare ? trunk : join(trunk, '.git'), 'rev-parse', 'refs/heads/main');
  return { box, id, trunk, payload, receipt, tip };
}

test('#7951 clause 1: a trunk remote that is a non-bare checkout with main checked out takes the land job\'s push with updateInstead and lands on main [C7,P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, a submit, a pulled gate and one land job.
async t => {
  const { box, id, trunk, payload, receipt, tip } = await landInto(t, { bare: false });
  assert.equal(payload.checkout, true, 'the offer marks a checked-out trunk, so the push updates its work tree');
  assert.equal(receipt.outcome, 'landed', `the land job answered ${receipt.outcome}: ${receipt.detail}`);
  assert.deepEqual(receipt.landed, [id]);
  assert.equal(tip, receipt.trunk, 'main in the checked-out trunk is the landed tip');
  assert.ok(existsSync(join(trunk, 'web', `${id}.txt`)), 'the checkout\'s work tree holds the landed file');
  assert.equal(box.git(trunk, 'status', '--porcelain'), '', 'the checkout\'s work tree matches the landed tip');
});

test('#7951 clause 2: a trunk remote that is a bare repo still lands, with no checkout on its job [C7,P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, a submit, a pulled gate and one land job.
async t => {
  const { id, payload, receipt, tip } = await landInto(t, { bare: true });
  assert.equal(payload.checkout, undefined, 'a bare trunk has no work tree to update');
  assert.equal(receipt.outcome, 'landed', `the land job answered ${receipt.outcome}: ${receipt.detail}`);
  assert.deepEqual(receipt.landed, [id]);
  assert.equal(tip, receipt.trunk, 'main in the bare trunk is the landed tip');
});

test('#7951: a scp-like address of this host naming the checkout counts as checked out, and a dirty one refuses with LAND_HOST_CHECKOUT_DIRTY naming the next step [C7]', { timeout: 240_000 }, // budget: hang ceiling for a project, a submit, a pulled gate and one land job.
async t => {
  const { box, trunk, payload, receipt } = await landInto(t, { bare: false, dirty: true });
  assert.equal(trunkCheckedOut(`${userInfo().username}@127.0.0.1:${trunk}`, box.repo, 'refs/heads/main'), true, 'the board\'s own trunk.remote shape, user@address:path, resolves here');
  assert.equal(trunkCheckedOut(`someone-else@127.0.0.1:${trunk}`, box.repo, 'refs/heads/main'), false, 'another user\'s home is not looked into');
  assert.equal(trunkCheckedOut('git@example.invalid:owner/repo.git', box.repo, 'refs/heads/main'), false, 'another host is never a checkout here');
  assert.equal(payload.checkout, true);
  assert.equal(receipt.outcome, 'push-failed', `the land job answered ${receipt.outcome}: ${receipt.detail}`);
  assert.match(receipt.detail, /^LAND_HOST_CHECKOUT_DIRTY: the board host checkout at .+ has uncommitted changes, .+; next: commit or stash them in that checkout, then run pullboard land/u);
});
