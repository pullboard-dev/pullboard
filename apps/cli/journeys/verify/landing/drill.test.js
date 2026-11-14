/** @pullboard-test-loads apps/cli/tests/fixtures/landing/loader.js */
/** Kill a runner's land job during its merge; once the job's lease expires a second runner takes it and lands both items [B35,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../../packages/jobs/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { context } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
import { wakeIo } from '../../../src/io/landing/automatic.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { acceptGated } from '../../../tests/fixtures/pull.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { serveOnce } from '../../../tests/fixtures/pull.js';
import { submitAll } from '../../../tests/fixtures/pull.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';

/** Offer the land job as the automatic lander does after an accept, in this process at the main checkout. */
async function offerLanding(box) {
  let answer = null;
  const run = await captureCommandInProcess(async () => { answer = await landAfterAcceptance(context(wakeIo(box.repo))); return 0; }, [], { cwd: box.repo, env: { ...box.env } });
  assert.equal(run.code, 0, run.err);
  return answer;
}

/** The NODE_OPTIONS that pause a runner process inside its land job's merge step, writing its pid to `marker` first. */
function crashAtMerge(marker) {
  const loader = new URL('../../../tests/fixtures/landing/loader.js', import.meta.url).href;
  const preload = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
  return { NODE_OPTIONS: '--import=' + preload, PULLBOARD_PRIVATE_CRASH_STAGE: 'land-merge', PULLBOARD_PRIVATE_CRASH_MARKER: marker };
}

test('killing a runner during its land job\'s merge lets a second runner take the job after the lease expires and land both items [B35,P7]', { timeout: 300_000 }, // budget: hang ceiling for a project, two submits, two pulled gates and two runner landings.
async t => {
  const box = await pullProject(t, 2);
  const trunk = join(box.dir, 'trunk.git');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false }, trunk: { remote: trunk } }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: name the trunk remote of record [G1]');
  box.git(box.dir, 'clone', '-q', '--bare', box.repo, trunk);
  const submitted = await submitAll(box, box.ids);
  // The board's clock: it moves past the job's lease after the kill, as a real lease runs out while its runner is dead.
  let skew = 0;
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo, now: Date.now() + skew }) });
  for (const runner of ['r-gate-1', 'r-gate-2']) assert.equal((await serveOnce(box, queue.url, runner)).code, 0);
  box.ids.forEach((id, n) => {
    assert.equal(getItem(queue.board, id).item_status, 'submitted', `the pulled gate put #${id} in review`);
    acceptGated(queue.board, box.repo, id, submitted[n].commit);
  });
  const before = box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
  const offered = await offerLanding(box);
  const [job] = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(offered.offered, job?.id, `one land job: ${JSON.stringify(offered)}`);
  const { payload } = job.steps.find(step => step.name === 'offered').payload;
  assert.deepEqual(payload.items.map(entry => entry.id).sort((a, b) => a - b), box.ids, 'the job carries both accepted items');

  // The first runner pauses inside its merge step; the fixture kills that runner process there.
  const marker = join(box.runnerHome, 'land-merge.json');
  const first = serveOnce(box, queue.url, 'r-land-1', crashAtMerge(marker));
  t.after(() => { if (existsSync(marker)) try { process.kill(JSON.parse(readFileSync(marker, 'utf8')).pid, 'SIGKILL'); } catch { /* already gone */ } });
  await waitForCondition(() => existsSync(marker), 'the first runner reaches its land job\'s merge', { signal: AbortSignal.timeout(120_000), state: () => ({ jobs: jobsOf(queue.board.db, { kind: 'land' }).map(row => row.step) }) });
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(owner.stage, 'land-merge');
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid);
  process.kill(owner.pid, 'SIGKILL');
  const killed = await first;
  assert.equal(killed.code, null, `the killed process was the runner: ${killed.output}`);
  assert.equal(box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main'), before, 'the killed merge pushed nothing');
  const held = jobsOf(queue.board.db, { kind: 'land' })[0];
  assert.notEqual(held.step, 'done', 'the killed job is still open');
  for (const id of box.ids) assert.equal(getItem(queue.board, id).item_merged_commit, null);

  // Before the lease expires no runner can take the job; after it, a second runner takes it and lands both items.
  const early = await serveOnce(box, queue.url, 'r-land-2', {}, { deadlineMs: 0 });
  assert.match(early.output, /nothing to claim/u, `the live lease keeps the job: ${early.output}`);
  skew = LEASE_MS + 1000;
  const second = await serveOnce(box, queue.url, 'r-land-2');
  assert.equal(second.code, 0, second.output);
  const [done] = jobsOf(queue.board.db, { kind: 'land' });
  assert.equal(done.step, 'done');
  const { receipt } = done.steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.outcome, 'landed', second.output);
  assert.deepEqual([...receipt.landed].sort((a, b) => a - b), box.ids, 'the second runner landed both items');
  const tip = box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
  assert.equal(tip, receipt.trunk, 'trunk is the pushed merge');
  box.ids.forEach((id, n) => {
    box.git(box.dir, '--git-dir', trunk, 'merge-base', '--is-ancestor', submitted[n].commit, tip);
    assert.ok(getItem(queue.board, id).item_merged_commit, `#${id} carries its merged receipt`);
  });
});
