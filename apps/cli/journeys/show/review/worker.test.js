/** A review comparison whose worker died restarts from its recorded request, then is recorded unavailable [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import {
  fixtureAdd,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';
import {
  VERIFICATION_COMPARISON_PREFIX,
  comparisonRestartPlan,
} from '../../../../../packages/verify/index.js';

const ITEM = { item_id: 7, item_commit: 'a'.repeat(40), item_frozen_digest: 'digest:Page' };
const pending = [{ type: 'fact', text: VERIFICATION_COMPARISON_PREFIX + JSON.stringify({ item: 7, status: 'pending', source: ITEM.item_commit, digest: ITEM.item_frozen_digest }) }];

/** Block this test for a while between polls of another process; nothing else runs in the test. */
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** A private common dir per case, removed afterwards. */
function commonDirectory(t) {
  const directory = privateFixtureFiles('pb-compare-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Record one comparison job the way launchComparisonWorker does. */
function job(commonDir, name, pid, overrides = {}) {
  const directory = join(commonDir, 'pullboard', 'review-comparisons', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ item: 7, source: ITEM.item_commit, digest: ITEM.item_frozen_digest, ...overrides }));
  if (pid !== null) writeFileSync(join(directory, 'worker.json'), JSON.stringify({ pid }));
}

test('clause 1: a comparison whose worker was killed mid-run restarts from its recorded request [C7]', async t => {
  const commonDir = commonDirectory(t);
  // Process-level: a real live pid, then SIGKILL, is what the restart plan reads; no in-process stand-in has a pid to kill.
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(worker, 'spawn');
  job(commonDir, 'one', worker.pid);
  assert.equal(comparisonRestartPlan({ commonDir, item: ITEM, thread: pending }).action, 'none', 'a live worker is left alone');
  worker.kill('SIGKILL');
  await once(worker, 'exit');
  assert.equal(comparisonRestartPlan({ commonDir, item: ITEM, thread: pending }).action, 'restart', 'the killed worker is replaced');
  job(commonDir, 'other-item', 1, { item: 8 });
  assert.equal(comparisonRestartPlan({ commonDir, item: ITEM, thread: [] }).action, 'none', 'a comparison that is not pending needs nothing');
});

test('clause 2: a comparison restarted three times for dead workers is recorded unavailable with the reason [C7]', t => {
  const commonDir = commonDirectory(t);
  const dead = () => false;
  const plan = () => comparisonRestartPlan({ commonDir, item: ITEM, thread: pending, alive: dead });
  job(commonDir, 'j0', 1);
  assert.equal(plan().action, 'restart', 'first death');
  job(commonDir, 'j1', 1);
  assert.equal(plan().action, 'restart', 'second death');
  job(commonDir, 'j2', 1);
  assert.equal(plan().action, 'restart', 'third death');
  job(commonDir, 'j3', 1);
  const final = plan();
  assert.equal(final.action, 'unavailable', 'the fourth dead worker is the third restart failing');
  assert.match(final.error, /died 4 times, restarted 3/u);
});

test('clause 1: next --verify starts a new worker for a killed comparison and show stops saying pending [C7]', { timeout: 240_000 }, async t => {
  const fixtures = createE2eHelpers();
  t.after(fixtures.cleanup);
  const box = fixtures.project('true');
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', reviewer, '-b', 'web/two');
  assert.equal((await joinFixtureSeat(box, reviewer, 'web', { model: 'fixture-reviewer', run: box.runLocal })).code, 0);
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Greet', '--specs', 'G1', '--criterion', 'It greets.');
  assert.equal(added.code, 0, added.err);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web', 'greet.txt'), 'hello\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): greet [G1]');
  const submitted = (await box.runLocal(box.web, 'submit', '1'));
  assert.equal(submitted.code, 0, submitted.err);

  // Control the worker instead of racing it: let any real worker the submit started finish, then record the exact
  // state a killed worker leaves: a newer pending record, and a job folder whose worker pid names a dead process.
  const common = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const jobs = join(common, 'pullboard', 'review-comparisons');
  const started = () => existsSync(jobs) ? readdirSync(jobs).filter(name => existsSync(join(jobs, name, 'worker.json'))) : [];
  const pidOf = name => JSON.parse(readFileSync(join(jobs, name, 'worker.json'), 'utf8')).pid;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  const deadline = Date.now() + 60_000;
  while ((!started().length || started().some(name => alive(pidOf(name)))) && Date.now() < deadline) pause(200);
  assert.ok(started().length, 'submit started a comparison worker');
  assert.ok(!started().some(name => alive(pidOf(name))), 'the submit-started worker has ended');
  const known = JSON.parse((await box.runLocal(box.repo, 'show', '1', '--json')).out);
  // Process-level: a real process killed with SIGKILL leaves the dead pid the restart plan must see.
  const stand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(stand, 'spawn');
  stand.kill('SIGKILL');
  await once(stand, 'exit');
  const request = { item: 1, source: known.item_commit, digest: known.item_frozen_digest };
  const killed = join(jobs, 'killed-worker');
  mkdirSync(killed, { recursive: true });
  writeFileSync(join(killed, 'request.json'), JSON.stringify(request));
  writeFileSync(join(killed, 'worker.json'), JSON.stringify({ pid: stand.pid }));
  assert.equal((await box.runLocal(box.repo, 'fact', '1', 'measurement', VERIFICATION_COMPARISON_PREFIX + JSON.stringify({ ...request, status: 'pending' }))).code, 0);
  const firstPids = started().map(pidOf);
  assert.ok((await box.runLocal(box.repo, 'show', '1')).out.includes('comparison pending'), 'the killed comparison is pending: nothing restarted it yet');

  const offered = (await box.runLocal(reviewer, 'next', '--verify'));
  assert.equal(offered.code, 0, offered.err);
  const fresh = started().map(pidOf).filter(pid => !firstPids.includes(pid));
  assert.ok(fresh.length >= 1, 'next --verify started a new comparison worker with its own pid');

  const settle = Date.now() + 150_000;
  let shown = (await box.runLocal(box.repo, 'show', '1')).out;
  while (shown.includes('comparison pending') && Date.now() < settle) { pause(1000); shown = (await box.runLocal(box.repo, 'show', '1')).out; }
  assert.ok(!shown.includes('comparison pending'), 'show stops saying comparison pending once the restarted worker answers');
});
