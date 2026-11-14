/** The crash drill shared by the per-stage files under apps/cli/journeys/verify/landing/drill [B35]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from '../../../index.js';
import { landAfterAcceptance } from '../../../index.js';
import { wakeIo } from '../../../src/io/landing/automatic.js';
import { captureCommandInProcess } from '../process.js';
import { acceptGated } from '../pull.js';
import { pullProject } from '../pull.js';
import { pullQueue } from '../pull.js';
import { serveOnce } from '../pull.js';
import { submitAll } from '../pull.js';
import { createE2eHelpers } from '../e2e.js';
import { FIXTURE_MODEL } from '../e2e.js';
import { startFixtureChild } from '../child.js';
import { waitForFixtureProgress } from '../progress.js';
import { json } from '../land/board.js';
import { onBoard } from '../land/board.js';
import { waitForCondition } from '../runner/holders.js';

/** Commit fixture inputs through ordinary hooks. */
function commit(box, root, subject) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', subject);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Prepare two independent submitted heads before the first acceptance can move main. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG, gate: 'true', landing: { manualOverride: false } }));
  commit(box, box.repo, 'chore: configure automatic crash recovery');
  const remote = join(box.dir, 'remote.git');
  box.git(box.repo, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const api = join(box.dir, 'api-builder');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/crash');
  json(box, api, 'join', 'api');
  const entries = [[box.web, 'web', 'G1'], [api, 'api', 'G2']].map(([root, lane, spec]) => {
    const file = `${lane}/crash.txt`;
    const id = json(box, box.repo, 'add', lane, 'Crash drill ' + lane, '--route', 'mid',
      '--criterion', file + ' exists', '--specs', spec, '--check', 'test -f ' + file,
      '--brief', `Files: ${file}\nChange: create a fixture payload for the interrupted landing.\nTest: the accepted payload lands after the interrupted batch resumes.`).item.item_id;
    json(box, root, 'claim', String(id));
    mkdirSync(join(root, lane), { recursive: true });
    writeFileSync(join(root, file), lane + '\n');
    const head = commit(box, root, `feat(${lane}): crash drill input [${spec}]`);
    json(box, root, 'submit', String(id));
    return { id, head, file, lane };
  });
  // Main moves after both submits, so no submit receipt answers for a landing tree and each landing gate really runs [C7].
  writeFileSync(join(box.repo, 'main-moved-after-submit.txt'), 'main moved after the submits\n');
  commit(box, box.repo, 'chore: move main after the submits');
  const reviewer = join(box.dir, 'crash-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, entries[0].head);
  json(box, reviewer, 'join', 'api', '--model', FIXTURE_MODEL, '--route', 'strong');
  return { box, entries, reviewer, remote };
}

/** Kill only the worker PID named by the injected boundary in this fixture's own private subprocess. */
async function crash(t, box, reviewer, id, stage, { getItem, landingBatches }) {
  const marker = join(box.dir, stage + '-worker.json');
  const loader = new URL('./loader.js', import.meta.url).href;
  const preload = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`);
  const child = startFixtureChild(process.execPath, [fileURLToPath(new URL('../../../pullboard.js', import.meta.url)),
    'verify', String(id), 'accept', '--note', 'Read actual fixture source and frozen check.', '--json'], {
    cwd: reviewer, env: { ...box.env, NODE_OPTIONS: [box.env.NODE_OPTIONS, '--import=' + preload].filter(Boolean).join(' '),
      PULLBOARD_PRIVATE_CRASH_STAGE: stage, PULLBOARD_PRIVATE_CRASH_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let workerKilled = false;
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (!workerKilled && existsSync(marker)) {
      const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  await waitForFixtureProgress({ child, ready: () => existsSync(marker), progress: () => output.length, description: 'landing reaches ' + stage + ' ' + JSON.stringify(output) });
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(owner.stage, stage);
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid);
  const before = onBoard(box, board => landingBatches(board).at(-1));
  assert.ok(before && before.state !== 'landed', 'a durable unfinished batch precedes the real kill');
  process.kill(owner.pid, 'SIGKILL');
  workerKilled = true;
  // Landing runs inside the accepting command's own process (f226542983), so the kill ends that command; the
  // recorded verdict is what survives it.
  const [code, signal] = await closed;
  assert.equal(signal, 'SIGKILL', 'the killed process was the landing: ' + JSON.stringify({ code, output }));
  assert.equal(onBoard(box, board => getItem(board, id).item_status), 'verified', 'the verdict survives the killed landing');
  return before.id;
}

/**
 * The drill for one stage: kill the landing worker there, then prove the next accept lands both items without manual recovery.
 * One stage per file keeps each file well under the gate's per-file budget (#5738). The test file passes the board reads
 * (`getItem`, `landingBatches`), since a fixture under apps/cli imports no store cell.
 */
export function drillCase(stage, reads) {
  const { getItem, landingBatches } = reads;
  return async t => {
    const { box, entries, reviewer, remote } = fixture(t);
    const batch = await crash(t, box, reviewer, entries[0].id, stage, reads);
    assert.equal(json(box, box.repo, 'show', String(entries[0].id)).item_merged_commit, null);
    box.git(reviewer, 'checkout', '-q', '--detach', entries[1].head);
    const secondAccept = box.run(reviewer, 'verify', String(entries[1].id), 'accept', '--note', 'Read second independent fixture head and frozen check.', '--json');
    assert.equal(secondAccept.code, 0, `${secondAccept.err}\n${secondAccept.out}`);
    const acceptance = JSON.parse(secondAccept.out);
    await waitForCondition(() => onBoard(box, board => entries.every(entry => getItem(board, entry.id)?.item_merged_commit)),
      `the recovered ${stage} landing records both accepted items`, {
        signal: AbortSignal.timeout(180_000),
        state: () => onBoard(box, board => entries.map(entry => ({ id: entry.id, status: getItem(board, entry.id)?.item_status,
          merged: getItem(board, entry.id)?.item_merged_commit }))),
      });
    for (const entry of entries) {
      const item = json(box, box.repo, 'show', String(entry.id));
      assert.ok(item.item_merged_commit,
        `native merged receipt exists for ${entry.id} after accept ${JSON.stringify(acceptance)}; stderr: ${secondAccept.err}`);
      box.git(box.repo, 'merge-base', '--is-ancestor', entry.head, 'main');
      assert.equal(readFileSync(join(box.repo, entry.file), 'utf8'), entry.lane + '\n');
    }
    assert.equal(onBoard(box, board => landingBatches(board).find(row => row.id === batch).state), 'landed', 'the interrupted batch resumes');
    assert.equal(box.git(remote, 'rev-parse', 'refs/heads/main'), box.git(box.repo, 'rev-parse', 'main'), 'real remote and local main agree');
  };
}

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
 * @param {'land-merge' | 'pushing' | 'recording'} stage - Where the first runner dies: before its push, or after the push and before its receipt.
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
