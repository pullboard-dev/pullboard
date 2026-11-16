/** The crash drill shared by the per-stage files under apps/cli/journeys/verify/landing/drill: a runner's land job dies at a stage and a second runner finishes it [B35,P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
import { wakeIo } from '../../../src/io/landing/automatic.js';
import { captureCommandInProcess } from '../process.js';
import { acceptGated } from '../pull.js';
import { pullProject } from '../pull.js';
import { pullQueue } from '../pull.js';
import { serveOnce } from '../pull.js';
import { submitAll } from '../pull.js';
import { waitForCondition } from '../runner/holders.js';

// Budget: how long a pulled drill waits for a runner to reach the paused stage; a hang ceiling only.
const REACH_MS = 120_000;

/** Offer the land job as the automatic lander does after an accept, in this process at the main checkout. */
async function offerLanding(box) {
  let answer = null;
  const run = await captureCommandInProcess(async () => { answer = await landAfterAcceptance(context(wakeIo(box.repo))); return 0; }, [], { cwd: box.repo, env: { ...box.env } });
  assert.equal(run.code, 0, run.err);
  return answer;
}

/** The NODE_OPTIONS that pause a runner process at `stage` of its land job, writing its pid to `marker` first. */
function crashAt(stage, marker) {
  const loader = new URL('./loader.js', import.meta.url).href;
  const preload = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
  return { NODE_OPTIONS: '--import=' + preload, PULLBOARD_PRIVATE_CRASH_STAGE: stage, PULLBOARD_PRIVATE_CRASH_MARKER: marker };
}

/**
 * The pulled drill for one stage of a runner's land job: kill the runner there, let its lease expire, and prove a second
 * runner takes the job and ends with both items landed, whatever the first one had or had not pushed [B35,P7].
 * Why: accept only offers a land job (lander-v2 section 3), so there is no in-process landing worker left to kill.
 *
 * @param {'land-merge' | 'gating' | 'pushing' | 'recording'} stage - Where the first runner dies: before its check, before its push, or after the push and before its receipt.
 * @param {{ getItem: Function, jobsOf: Function, LEASE_MS: number, boardJobQueueCall: Function }} reads - Board reads the test file imports.
 */
export function pulledDrillCase(stage, reads) {
  const { getItem, jobsOf, LEASE_MS, boardJobQueueCall } = reads;
  return async t => {
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

    // The first runner pauses at the stage; the fixture kills that runner process there.
    const marker = join(box.runnerHome, stage + '.json');
    const first = serveOnce(box, queue.url, 'r-land-1', crashAt(stage, marker));
    t.after(() => { if (existsSync(marker)) try { process.kill(JSON.parse(readFileSync(marker, 'utf8')).pid, 'SIGKILL'); } catch { /* already gone */ } });
    await waitForCondition(() => existsSync(marker), `the first runner reaches ${stage}`, { signal: AbortSignal.timeout(REACH_MS), state: () => ({ jobs: jobsOf(queue.board.db, { kind: 'land' }).map(row => row.step) }) });
    const owner = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(owner.stage, stage);
    assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid);
    process.kill(owner.pid, 'SIGKILL');
    const killed = await first;
    assert.equal(killed.code, null, `the killed process was the runner: ${killed.output}`);
    const pushedAlready = stage === 'recording';
    const afterKill = box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
    if (pushedAlready) assert.notEqual(afterKill, before, 'the runner pushed before it died');
    else assert.equal(afterKill, before, 'the killed runner pushed nothing');
    assert.notEqual(jobsOf(queue.board.db, { kind: 'land' })[0].step, 'done', 'the killed job is still open');
    for (const id of box.ids) assert.equal(getItem(queue.board, id).item_merged_commit, null, 'no receipt, so the board has not recorded the landing');

    // Before the lease expires no runner can take the job; after it, a second runner takes it and finishes both items.
    const early = await serveOnce(box, queue.url, 'r-land-2', {}, { deadlineMs: 0 });
    assert.match(early.output, /nothing to claim/u, `the live lease keeps the job: ${early.output}`);
    skew = LEASE_MS + 1000;
    const second = await serveOnce(box, queue.url, 'r-land-2');
    assert.equal(second.code, 0, second.output);
    const [done] = jobsOf(queue.board.db, { kind: 'land' });
    assert.equal(done.step, 'done');
    const { receipt } = done.steps.find(step => step.name === 'receipt').payload;
    assert.equal(receipt.outcome, 'landed', second.output);
    const settled = [...receipt.landed, ...receipt.already].sort((a, b) => a - b);
    assert.deepEqual(settled, box.ids, 'the second runner landed, or found already on trunk, both items');
    if (pushedAlready) assert.deepEqual(receipt.landed, [], 'the first runner\'s push already landed them; the second pushes nothing');
    const tip = box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
    assert.equal(tip, receipt.trunk, 'trunk is the pushed merge');
    if (pushedAlready) assert.equal(tip, afterKill, 'the second runner left the first runner\'s push alone');
    box.ids.forEach((id, n) => {
      box.git(box.dir, '--git-dir', trunk, 'merge-base', '--is-ancestor', submitted[n].commit, tip);
      assert.ok(getItem(queue.board, id).item_merged_commit, `#${id} carries its merged receipt`);
    });
  };
}
