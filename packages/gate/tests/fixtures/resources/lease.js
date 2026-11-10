/** Real CLI scenario for a review, submit or check that keeps its item lease while queued [C7,V4]. */
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import { checkBaseline } from '../../../index.js';
import { main as nativeTestMain } from '../../../../../apps/cli/tests/fixtures/native.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../store/index.js';
import { openBoard } from '../../../../../apps/lib/index.js';
import { exportBoard } from '../../../../store/index.js';
import { importBoard } from '../../../../store/index.js';
import { appliedSequence } from '../../../../state/index.js';
import { applyEngineMove } from '../../../../state/index.js';
import { prepareEngineMove } from '../../../../state/index.js';
import { SUBMIT_ADMISSION_ENGINE } from '../../../../state/light.js';
import { registerProject } from '../../../../seats/index.js';
import { serveView } from '../../../../../apps/cli/src/io/commands/view.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';

export { resourceWorkerSources, resourceNames, oldSchema, staleIdentity, expireHeartbeat } from '../../../../../apps/cli/tests/fixtures/resources/lease.js';

/** Run a scoped view against a private registry and machine home, restoring both on close. */
export async function openPrivateScopedView(box) {
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  const restore = () => {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  };
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.home;
  try {
    registerProject(box.first);
    const view = await serveView({ port: 0, projectRoot: box.first, runCommand: nativeTestMain });
    return { ...view, close: async () => { try { await view.close(); } finally { restore(); } } };
  } catch (error) { restore(); throw error; }
}

const CLOCKED_CLI = `
import { readFileSync } from 'node:fs';
import { main } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../../apps/cli/tests/fixtures/native.js')).href)};
/** The private test alone controls the board clock; resource liveness still uses real OS time. */
const clock = { now: () => new Date(Number(readFileSync(process.env.PULLBOARD_FIXTURE_CLOCK, 'utf8'))) };
process.exitCode = await main(process.argv.slice(1), {
  cwd: process.cwd(), clock, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
});
`;

/** Run the real CLI with a private file-backed board clock and the fixture's ordinary identity. */
function clockedCli(box, cwd, ...args) {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', CLOCKED_CLI, ...args],
    { cwd, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.failure ?? result.stderr}`);
  return args.includes('--json') ? JSON.parse(result.stdout) : result.stdout;
}

/** Track a waiting real CLI process in the same cleanup registry as the resource workers. */
function leaseCommand({ helpers, children }, box, cwd, ...args) {
  const child = helpers.launch(box, cwd, process.execPath, ['--input-type=module', '-e', CLOCKED_CLI, ...args]);
  child.lines = createInterface({ input: child.stdout });
  child.exitResult = null;
  child.finished = child.closed.then((result) => {
    child.exitResult = result;
    children.delete(child);
    return result;
  });
  children.add(child);
  return child;
}

/** Create genuine submitted/claimed items and independent reviewers before advancing any clock. */
function itemLeaseFixture(t, helpers) {
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // This scenario observes the synchronous submit's live queue lease; asynchronous handoffs return before that wait.
  writeFileSync(configFile, JSON.stringify({ ...config, lease: '1m', reviewLease: '1m', submit: { ...config.submit, handoff: false } }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure queue lease fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.first = box.repo;
  box.home = box.env.PULLBOARD_MACHINE_HOME;
  box.clockFile = join(box.dir, 'board-clock');
  writeFileSync(box.clockFile, String(Date.now()));
  box.env.PULLBOARD_FIXTURE_CLOCK = box.clockFile;
  box.clock = { now: () => new Date(Number(readFileSync(box.clockFile, 'utf8'))) };
  box.advance = (ms) => writeFileSync(box.clockFile, String(box.clock.now().getTime() + ms));
  box.board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), box.clock, { gitRoot: box.repo });
  t.after(() => store.closeBoard(box.board));
  box.gates = [];
  box.ids = [];
  box.reviewCommits = [];
  for (const number of [1, 2, 3, 4]) {
    const folder = join(box.dir, `item-gate-${number}`);
    mkdirSync(folder);
    const gate = helpers.holdingGate({ dir: folder });
    // Baseline measurement is setup, not the queued CLI under test. Measure it directly to avoid
    // four additional CLI/worker startups while preserving a real completed baseline for each item.
    const baseline = checkBaseline(box.repo, gate.command, { main: box.git(box.repo, 'rev-parse', 'main') });
    const id = store.addItem(box.board, { by: 'coordinator', lane: 'web', title: `Queued lease ${number}`,
      specIds: ['G1'], criterion: 'The queued command retains only its own live item lease.', check: gate.command, checkBaseline: baseline });
    assert.notEqual(store.getItem(box.board, id).item_check_baseline?.result, 'pending', 'the fixture completes its baseline before preparing any item claim');
    box.ids.push(id); box.gates.push(gate);
    if (number < 4) {
      // Each item has independent ancestry: a pending review cannot be another submit's base.
      box.git(box.web, 'switch', '-q', '--detach', 'main');
      clockedCli(box, box.web, 'claim', String(id), '--json');
      mkdirSync(join(box.web, 'web'), { recursive: true });
      writeFileSync(join(box.web, 'web', `queued-${number}.txt`), 'fixture\n');
      box.git(box.web, 'add', 'web');
      box.git(box.web, 'commit', '-q', '-m', 'feat(web): queue lease fixture [G1]');
      if (number < 3) {
        clockedCli(box, box.web, 'submit', String(id), '--json');
        box.reviewCommits.push(box.git(box.web, 'rev-parse', 'HEAD'));
      }
    }
  }
  box.reviewers = [];
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  for (const number of [1, 2]) {
    const root = join(box.dir, `queue-review-${number}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, box.reviewCommits[number - 1]);
    clockedCli(box, root, 'join', 'api', '--json');
    // A distinct clean reviewer HEAD prevents proof reuse: this fixture must exercise a queued real check.
    box.git(root, 'commit', '--allow-empty', '-q', '-m', 'test: run the queued review check');
    box.reviewers.push(root);
  }
  box.checker = join(box.dir, 'queue-build-check');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', box.checker, commit);
  clockedCli(box, box.checker, 'join', 'web', '--json');
  clockedCli(box, box.checker, 'claim', String(box.ids[3]), '--json');
  clockedCli(box, box.repo, 'settings', 'gateSlots', '2', '--json');
  return box;
}

/** Neither a fresh CLI submit nor an unwitnessed receiver move inherits a running command's admission. */
function refuseFreshExpiredSubmit(box, id) {
  const late = runFixtureChild(process.execPath, ['--input-type=module', '-e', CLOCKED_CLI, 'submit', String(id), '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(late.status, 1, late.stdout);
  assert.equal(JSON.parse(late.stdout).error.code, 'NOT_YOURS', 'a new submit cannot start on an expired claim');
  const replica = openBoard(join(box.dir, 'expired-submit-receiver.sqlite'), box.clock, { gitRoot: box.repo });
  try {
    importBoard(replica, exportBoard(box.board));
    const before = store.itemById(replica, id);
    const move = prepareEngineMove(replica, 'submit', [id, { agentId: before.item_owner,
      commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      policyCommit: box.git(box.repo, 'rev-parse', 'main'),
      submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'receiver negative control; no completed proof' } }]);
    const result = applyEngineMove(replica, move, { sequence: appliedSequence(replica) + 1, at: box.clock.now().toISOString() });
    assert.equal(result.error?.code, 'AGENT_GRANT_EXPIRED', 'even a real admission nonce grants no receiver completion without its native final proof');
    assert.deepEqual(store.itemById(replica, id), before, 'the refused receiver leaves the claimed item unchanged');
  } finally { store.closeBoard(replica); }
}

/** Replay the real completed native receipt; changed source or a new claim cannot borrow it. */
function admittedCompletionReplicas(box, id, snapshot) {
  const receipt = store.proofReceipts(box.board, id).findLast(run => run.submitAdmission);
  assert.ok(receipt, 'the real mandatory submit proof carries its admission witness');
  const proof = prepareEngineMove(box.board, 'recordProofRun', [{ agentId: receipt.seat, itemId: id, receiptId: receipt.id }]);
  for (const scenario of ['same admission', 'admission engine', 'different commit', 'different tree', 'reclaim', 'historical engine']) {
    let instant = box.clock.now().getTime();
    const clock = { now: () => new Date(instant) };
    const peer = openBoard(join(box.dir, `completion-${scenario.replaceAll(' ', '-')}.sqlite`), clock, { gitRoot: box.repo });
    try {
      importBoard(peer, snapshot);
      assert.equal(applyEngineMove(peer, proof, { sequence: appliedSequence(peer) + 1, at: clock.now().toISOString() }).error, undefined);
      const item = store.itemById(peer, id);
      if (scenario === 'reclaim') {
        const options = { agentId: item.item_owner, lane: item.item_lane, leaseMs: 60_000, head: receipt.commit };
        store.claim(peer, id, options);
        assert.throws(() => store.claim(peer, id, { ...options, submitAdmission: {
          id: receipt.submitAdmission, commit: receipt.commit, tree: receipt.tree } }), error => error.code === 'USAGE',
        'a new claim cannot reuse an earlier admission id');
        store.claim(peer, id, options);
        instant = Date.parse(store.itemById(peer, id).item_lease_until) + 1;
      }
      // A move from before strict composition replays on a board from before it was activated, so the
      // private peer drops the review-policy markers; the assertions below are unchanged.
      if (['admission engine', 'historical engine'].includes(scenario)) peer.db.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'review_%' OR meta_key LIKE 'line_setting:%'").run();
      const move = prepareEngineMove(peer, 'submit', [id, { agentId: receipt.seat,
        commit: scenario === 'different commit' ? '1'.repeat(receipt.commit.length) : receipt.commit,
        tree: scenario === 'different tree' ? '2'.repeat(receipt.tree.length) : receipt.tree,
        policyCommit: box.git(box.repo, 'rev-parse', 'main'),
        submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'private replay of actual native proof' } }]);
      if (['admission engine', 'historical engine'].includes(scenario)) {
        // These old writers predate clause-inspection fields; retain their actual wire shape.
        delete move.args[1].clausePolicyCommit;
        delete move.args[1].inspectClauses;
        move.engine = scenario === 'admission engine' ? SUBMIT_ADMISSION_ENGINE : SUBMIT_ADMISSION_ENGINE - 1;
      }
      const result = applyEngineMove(peer, move, { sequence: appliedSequence(peer) + 1, at: clock.now().toISOString() });
      assert.equal(result.error?.code, ['same admission', 'admission engine'].includes(scenario) ? undefined : 'AGENT_GRANT_EXPIRED', scenario);
    } finally { store.closeBoard(peer); }
  }
}

/** Inherit a genuine private lease and prove awaited admission runs before the nested action. */
function inheritedAdmissionProof(box) {
  const program = `
import assert from 'node:assert/strict';
import { takeResource, gateSlotEnvironment } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../resources/index.js')).href)};
import { withGateSlot } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href)};
${executionServicesSource(pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href)}
const root = process.cwd();
const lease = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', root, agent: 'inherited-admission-control' });
Object.assign(process.env, gateSlotEnvironment(lease));
try {
  let renewed = false;
  await withGateSlot(root, inherited => {
    assert.equal(inherited.inherited, true);
    assert.equal(renewed, true, 'renewal finishes before inherited work starts');
  }, { executionServices, onWait: async state => { assert.equal(state.admitted, true); await Promise.resolve(); renewed = true; } });
  const lost = new Error('private item lease lost');
  await assert.rejects(withGateSlot(root, () => assert.fail('lost admission must not run'), { executionServices,
    onWait: async () => { throw lost; },
  }), error => error === lost);
} finally { lease.release(); }
`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', program], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.failure ?? result.stderr}`);
}

/**
 * Run the queued-lease scenario against the resource suite's private pool helpers.
 *
 * Why a module: test/resources.test.js is over the 1500-line cap, so its long CLI scenarios
 * live beside it, as the release-first proof does, while the named test stays in that file.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ helpers: any, children: Set<any>, fixture: Function, poolWorker: Function, privateList: Function, privateTake: Function, acquired: Function, release: Function, waitUntil: Function }} deps
 */
export async function queuedLeaseProof(t, deps) {
  const { fixture, poolWorker, privateList, privateTake, acquired, release, waitUntil } = deps;
  const box = itemLeaseFixture(t, deps.helpers);
  const [reviewId, deadId, buildId, checkId] = box.ids;
  const [reviewGate, deadGate, buildGate, checkGate] = box.gates;
  const [reviewer, deadReviewer] = box.reviewers;
  // Readers project expired claims as open with no lease. Observe the retained raw deadline
  // here so admission's normal expiry remains distinguishable from an unwanted renewal.
  const item = (id) => store.itemById(box.board, id);
  const end = (id, kind) => item(id)[kind === 'review' ? 'item_review_until' : 'item_lease_until'];
  const waiting = (id) => privateList(box).find((resource) => resource.name === 'gate')?.line.find((entry) => entry.item === String(id));
  let holder;
  const commands = [];
  try {
    clockedCli(box, reviewer, 'next', '--verify', String(reviewId), '--json');
    const originalReviewEnd = end(reviewId, 'review');
    const originalBuildEnd = end(buildId, 'check');
    const originalCheckEnd = end(checkId, 'check');
    holder = poolWorker(box, { agent: 'lease-test-holder', browser: true });
    await acquired(holder);
    writeFileSync(reviewGate.mode, 'hold'); writeFileSync(buildGate.mode, 'hold'); writeFileSync(checkGate.mode, 'hold');
    const review = leaseCommand(deps, box, reviewer, 'verify', String(reviewId), 'accept',
      '--note', 'Private fixture: waited behind held capacity and ran the frozen check.', '--json');
    commands.push(review);
    await waitUntil(() => {
      assert.equal(review.exitResult, null, `verify exited before queueing: ${review.stdoutText}\n${review.stderrText}`);
      return waiting(reviewId)?.leaseUntil;
    }, 'the real verify waiter and its item lease end');
    const build = leaseCommand(deps, box, box.web, 'submit', String(buildId), '--json');
    commands.push(build);
    try {
      await waitUntil(() => {
        assert.equal(build.exitResult, null, `submit exited before queueing: ${build.stdoutText}\n${build.stderrText}`);
        return waiting(buildId)?.leaseUntil;
      }, 'the real submit waiter and its item lease end', 30_000); // budget: the real CLI completes source and static preflight before entering the held pool.
    } catch (error) {
      throw new Error(`${error.message}\nsubmit stdout: ${build.stdoutText}\nsubmit stderr: ${build.stderrText}\nresource queue: ${JSON.stringify(privateList(box))}`, { cause: error });
    }
    const check = leaseCommand(deps, box, box.checker, 'check', String(checkId), '--yes', '--json');
    commands.push(check);
    await waitUntil(() => waiting(checkId)?.leaseUntil, 'the independent owned check and its item lease end');
    const listed = clockedCli(box, box.repo, 'resources', '--json').resources.find((resource) => resource.name === 'gate');
    for (const [id, kind] of [[reviewId, 'review'], [buildId, 'submit'], [checkId, 'check']]) {
      const entry = listed.line.find((row) => row.item === String(id));
      assert.equal(entry.kind, kind);
      assert.equal(entry.leaseUntil, end(id, kind), 'resources reports this exact board item lease, not the pool heartbeat');
    }
    assert.match(clockedCli(box, box.repo, 'resources'), /lease until \d{4}-\d{2}-\d{2}T/u);

    box.advance(30_000);
    await waitUntil(() => end(reviewId, 'review') > originalReviewEnd && end(buildId, 'check') > originalBuildEnd
      && end(checkId, 'check') > originalCheckEnd, 'all live queued commands renew before their original expiry');
    const previousReviewEnd = end(reviewId, 'review');
    const previousBuildEnd = end(buildId, 'check');
    const previousCheckEnd = end(checkId, 'check');
    box.advance(31_000);
    await waitUntil(() => end(reviewId, 'review') > previousReviewEnd && end(buildId, 'check') > previousBuildEnd
      && end(checkId, 'check') > previousCheckEnd, 'all leases remain held past their original deadlines');
    assert.ok(box.clock.now().toISOString() > originalReviewEnd);
    assert.ok(end(reviewId, 'review') > box.clock.now().toISOString());
    assert.ok(end(buildId, 'check') > box.clock.now().toISOString());
    assert.ok(end(checkId, 'check') > box.clock.now().toISOString());

    await release(holder); holder = null;
    await waitUntil(() => existsSync(reviewGate.events), 'the admitted verification starts its actual frozen check');
    const runningReviewEnd = end(reviewId, 'review');
    for (const advance of [30_000, 31_000, 1_000]) {
      const beforeBuildEnd = end(buildId, 'check');
      const beforeCheckEnd = end(checkId, 'check');
      box.advance(advance);
      if (advance >= 30_000) await waitUntil(() => end(buildId, 'check') > beforeBuildEnd
        && end(checkId, 'check') > beforeCheckEnd, 'both build waiters renew while the admitted review runs');
    }
    assert.equal(end(reviewId, 'review'), runningReviewEnd, 'admission ends review item renewals');
    assert.ok(runningReviewEnd < box.clock.now().toISOString(), 'the running review resumes ordinary lease expiry');
    assert.ok(waiting(buildId) && waiting(checkId), 'submit and check remain queued behind the review');
    writeFileSync(reviewGate.release, 'release');
    assert.equal((await review.finished).code, 0, `${review.stdoutText}\n${review.stderrText}`);
    await waitUntil(() => existsSync(buildGate.events), 'the admitted real submit starts its frozen check');
    const runningBuildEnd = end(buildId, 'check');
    for (const advance of [30_000, 31_000, 1_000]) {
      const beforeCheckEnd = end(checkId, 'check');
      box.advance(advance);
      if (advance >= 30_000) await waitUntil(() => end(checkId, 'check') > beforeCheckEnd,
        'the standalone check keeps renewing while submit runs');
    }
    clockedCli(box, box.repo, 'resources', '--json');
    assert.equal(end(buildId, 'check'), runningBuildEnd, 'admission ends build item renewals');
    assert.ok(runningBuildEnd < box.clock.now().toISOString(), 'the running build resumes ordinary lease expiry');
    refuseFreshExpiredSubmit(box, buildId);
    const admittedBuild = exportBoard(box.board);
    writeFileSync(buildGate.release, 'release');
    assert.equal((await build.finished).code, 0, `${build.stdoutText}\n${build.stderrText}`);
    assert.equal(item(buildId).item_status, 'submitted', 'the actual queued submit completes its ordinary board move');
    admittedCompletionReplicas(box, buildId, admittedBuild);
    await waitUntil(() => existsSync(checkGate.events), 'the independent owned check starts');
    const runningCheckEnd = end(checkId, 'check');
    box.advance(Date.parse(runningCheckEnd) - box.clock.now().getTime() + 1);
    clockedCli(box, box.repo, 'resources', '--json');
    assert.equal(end(checkId, 'check'), runningCheckEnd, 'admission ends standalone check renewals');
    assert.ok(runningCheckEnd < box.clock.now().toISOString(), 'the standalone check resumes normal expiry');
    writeFileSync(checkGate.release, 'release');
    assert.equal((await check.finished).code, 0, `${check.stdoutText}\n${check.stderrText}`);

    clockedCli(box, deadReviewer, 'next', '--verify', String(deadId), '--json');
    holder = poolWorker(box, { agent: 'dead-waiter-holder', browser: true });
    await acquired(holder);
    const dead = leaseCommand(deps, box, deadReviewer, 'verify', String(deadId), 'accept',
      '--note', 'Private fixture: the queued waiter must not start before its holder releases.', '--json');
    commands.push(dead);
    await waitUntil(() => waiting(deadId)?.leaseUntil, 'the doomed real reviewer is queued with its item lease');
    const beforeDeadEnd = end(deadId, 'review');
    box.advance(30_000);
    await waitUntil(() => end(deadId, 'review') > beforeDeadEnd, 'the reviewer renews while alive');
    assert.equal(existsSync(deadGate.events), false, 'the killed waiter never started its frozen check');
    dead.kill('SIGKILL');
    assert.equal((await dead.finished).signal, 'SIGKILL');
    await waitUntil(() => !waiting(deadId), 'the real dead waiter is pruned');
    const lastDeadEnd = end(deadId, 'review');
    box.advance(Date.parse(lastDeadEnd) - box.clock.now().getTime() + 1);
    assert.equal(end(deadId, 'review'), lastDeadEnd, 'a dead process cannot continue renewing');
    clockedCli(box, reviewer, 'next', '--verify', String(deadId), '--json');
    assert.equal(item(deadId).item_review_by, store.agentAt(box.board, reviewer).agent_id,
      'another actual reviewer can reserve after the dead waiter lease lapses');

    await t.test('asynchronous renewal finishes outside the queue transaction before admission', async () => {
      const callbackBox = fixture();
      const callbackHolder = await privateTake(callbackBox, { name: 'awaited-renewal', capacity: 1 });
      let enter;
      let finish;
      const entered = new Promise((resolve) => { enter = resolve; });
      const barrier = new Promise((resolve) => { finish = resolve; });
      const refused = new Error('fixture item lease was lost while waiting');
      let completed = false;
      const queued = privateTake(callbackBox, { name: 'awaited-renewal', capacity: 1, onWait: async () => {
        const connection = new DatabaseSync(join(callbackBox.home, 'resources.sqlite'));
        try { connection.exec('BEGIN IMMEDIATE'); connection.exec('ROLLBACK'); }
        finally { connection.close(); }
        enter();
        await barrier;
        completed = true;
        throw refused;
      } }).then((lease) => ({ lease }), (error) => ({ error }));
      await entered;
      callbackHolder.release();
      finish();
      const result = await queued;
      try {
        assert.equal(completed, true);
        assert.equal(result.error, refused, 'a failed awaited renewal refuses admission instead of running stale work');
        const pool = privateList(callbackBox).find((entry) => entry.name === 'awaited-renewal');
        assert.deepEqual(pool.line, [], 'failed renewal removes its waiter');
        assert.deepEqual(pool.holders, [], 'failed renewal never leaves a held resource');
      } finally { result.lease?.release(); }
    });
    await t.test('an inherited native slot awaits item admission and refuses a lost lease', () => inheritedAdmissionProof(box));
  } finally {
    for (const gate of box.gates) writeFileSync(gate.release, 'release');
    if (holder && !holder.exitResult) await release(holder);
    // Released gates let each CLI reap its own check workers and private clone before the
    // shared fixture directory is removed. Killing a parent here would strand those workers.
    await Promise.all(commands.map((child) => child.finished));
    for (const child of commands) child.lines.close();
  }
}
