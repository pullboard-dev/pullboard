/**
 * A submit handoff whose worker is gone is recovered whether it was queued or running, and the next submit queues; a
 * live driver whose lease lapsed is never declared dead [C7,V4].
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { driverRecord } from '../../../tests/fixtures/gate/driver.js';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { withFixtureBoard } from '../../../tests/fixtures/testkit.js';
import { createJob } from '../../../../../packages/jobs/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { exactStart } from '../../../../../packages/gate/index.js';
import { runGateStages } from '../../../../../packages/gate/index.js';
import { admitGateDrive } from '../../../../../packages/drive/index.js';
import { drainLoop } from '../../../../../packages/drive/index.js';
import { gateDriveJobId } from '../../../../../packages/drive/index.js';
import { gateDriverGone } from '../../../../../packages/drive/index.js';
import { GATE_DRIVE_KIND } from '../../../../../packages/drive/index.js';
import { readGateDrive } from '../../../../../packages/drive/index.js';
import { recordJobRow } from '../../../../../packages/drive/index.js';
import { rowSink } from '../../../../../packages/drive/index.js';
import { recordGateDriveSpawn } from '../../../../../packages/drive/index.js';
import { drivenHandoffGate } from '../../../src/io/submit/handoff/worker.js';
import { deadWorker } from '../../../src/io/alive.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { openBoard } from '../../../../lib/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureOpenBoard } from '../../../tests/fixtures/testkit.js';
import * as store from '../../../../../packages/store/index.js';
import { randomUUID } from 'node:crypto';
import { gateSettled } from '../../../tests/fixtures/submit/handoff.js';
import { removeSandboxes } from '../../../tests/fixtures/submit/handoff.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state the separate worker wrote, without writing anything. */
function state(box, id) {
  // @pullboard-board-file journey: observe the detached worker's actual persisted queue record.
  const board = openBoard(box.boardFile);
  try { return { item: getItem(board, id), job: submitHandoff(board, id) }; }
  finally { board.db.close(); }
}

/** Quote a private fixture path for the configured shell command. */
function word(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

/** A native project with handoff on and a gate that holds while the candidate says "hold", until released. */
function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const release = join(box.dir, 'release'), started = join(box.dir, 'started');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const value = fs.existsSync('web/snapshot.txt') ? fs.readFileSync('web/snapshot.txt', 'utf8').trim() : 'base';",
    "if (value === 'hold') {",
    ` fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
    '}',
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Dead running handoff', '--specs', 'G1',
    '--criterion', 'A dead running handoff never blocks the next submit.', '--check', `${word(process.execPath)} ${word(script)}`, '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => !['queued', 'running'].includes(state(box, id).job?.state), 'queued worker finished', 120000); // budget: cleanup ceiling, no timing assertion.
    // The driver and dispatcher still write for a moment after the job ends, and the synchronous cleanup never
    // re-walks a tree written behind it: remove the tree only once they are done, with async retries (#3495).
    await gateSettled(helpers, box, state(box, id).job?.id);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, id, started };
}

test('#3995 clause 1: killing the submit worker mid-tests relaunches the same gate, which finishes from its last recorded section with no SUBMIT_HANDOFF_DEAD [C7,V4]', async t => {
  const box = fixture(t);
  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'hold\n', 'feat(web): held candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).queued, true);
  await box.helpers.waitFor(() => existsSync(box.started) && state(box, box.id).job?.state === 'running', 'the gate is running', 120000); // budget: real worker start ceiling, no timing assertion.
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  const owner = driverRecord(box.boardFile, first.id);
  // The worker leads its own detached process group; killing the group leaves no live gate behind, like a crash.
  process.kill(-owner.pid, 'SIGKILL');
  await box.helpers.waitFor(() => gone(owner.pid), 'the worker is gone', 120000); // budget: kill ceiling, no timing assertion.
  assert.equal(state(box, box.id).job.state, 'running', 'the dead worker left its job marked running');
  // Let the relaunched gate pass its held section, then ask for the same head again: recovery relaunches the job.
  writeFileSync(join(box.dir, 'release'), 'release\n');
  const again = box.run(box.web, 'submit', String(box.id), '--no-next', '--json');
  assert.doesNotMatch(again.out + again.err, /SUBMIT_HANDOFF_DEAD/u, 'a dead running worker never ends the gate');
  await box.helpers.waitFor(() => driverRecord(box.boardFile, first.id)?.relaunches === 1, 'the same job was relaunched', 120000); // budget: relaunch ceiling, no timing assertion.
  await box.helpers.waitFor(() => ['green', 'submitted'].includes(state(box, box.id).job?.state), 'the relaunched gate finished', 120000); // budget: real gate ceiling, no timing assertion.
  const after = state(box, box.id);
  assert.equal(after.job.id, first.id, 'the gate finished on its original job');
  assert.equal(existsSync(join(directory, 'refusal.json')), false, 'no refusal was written for the dead worker');
  assert.equal(after.item.item_status, 'submitted');
});

/** The lease renewal interval the blocked-driver tests run with; production renews every 5 s. */
const TICK_MS = 25;
/** How long the blocked driver's event loop is held, on the drive's own clock: past the 2-minute lease. */
const BLOCKED_MS = 3 * 60_000;

/** A real repo with one commit, so the gate drive has a candidate tree to capture. */
function candidateRepo() {
  const files = privateFixtureFiles('pullboard-blocked-repo-');
  runFixtureGit(['-C', files.root, 'init', '-q']);
  runFixtureGit(['-C', files.root, 'config', 'user.email', 'blocked@example.test']);
  runFixtureGit(['-C', files.root, 'config', 'user.name', 'Blocked Test']);
  files.write('a.txt', 'candidate\n');
  runFixtureGit(['-C', files.root, 'add', '-A']);
  runFixtureGit(['-C', files.root, 'commit', '-q', '-m', 'candidate']);
  return { repo: files.root, commit: runFixtureGit(['-C', files.root, 'rev-parse', 'HEAD']) };
}

/**
 * Drive one admitted gate with the hand-off worker's own drive, this process as its driver, on job rows a recorder
 * writes to a real board file. Its tests section blocks the event loop and moves the drive's clock 3 minutes, so the
 * lease lapses with no renewal, as a stalled driver's does; it observes the record then, awaits the next tick's take
 * row, and observes the lease.
 */
async function blockedDrive() {
  const { repo, commit } = candidateRepo();
  const files = privateFixtureFiles('pullboard-blocked-board-');
  return withFixtureBoard(join(files.root, 'board.sqlite'), async board => {
    const db = board.db;
    const handoff = '7a1b2c3d-0000-4000-8000-000000003836';
    const id = gateDriveJobId(handoff);
    const owner = 'driver-blocked';
    let skew = 0;
    const now = () => Date.now() + skew;
    createJob(db, { id, kind: GATE_DRIVE_KIND, item: 7, candidate: commit, base: commit });
    admitGateDrive(db, handoff, { owner });
    recordGateDriveSpawn(db, handoff, { owner, pid: process.pid, started: exactStart(process.pid) });
    const seen = {};
    let retook;
    const retaken = new Promise(resolve => { retook = resolve; });
    const rows = rowSink(jobView(db, id), row => {
      const answer = recordJobRow(db, row);
      if (row.type === 'ticket' && row.action === 'take') retook(answer);
      return answer;
    });
    const stage = async name => {
      if (name !== 'tests') return { name };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4 * TICK_MS);
      skew += BLOCKED_MS;
      const record = readGateDrive(db, handoff);
      seen.blocked = { lapsed: gateDriverGone(record, now()), dead: deadWorker(record, { id: handoff }, now()) };
      const taken = await retaken;
      const view = jobView(db, id);
      seen.after = { taken, owner: view.leaseOwner, live: view.leaseUntil > now() };
      return { name };
    };
    const submit = async (ctx) => {
      await (ctx.runGateStages ?? runGateStages)(['preflight', 'selection', 'cells', 'doctrine', 'static', 'tests'].map(name => ({ name, run: () => stage(name) })));
      ctx.submissionResult.value = { commit };
    };
    const gate = drivenHandoffGate({}, { item: 7 }, { waitInventory: async () => null, submit });
    const last = await drainLoop(rows, id, { owner, repo, gate, intervalMs: 5, stallCheckMs: TICK_MS, now });
    return { last, job: jobView(db, id), seen, commit };
  });
}

test('clause 1: a driver whose renewal is refused for a lapsed lease retakes the lease on its next tick [C7]', { timeout: 30_000 }, async () => {
  const { seen } = await blockedDrive();
  assert.equal(seen.blocked.lapsed, true, 'the blocked driver\'s lease lapsed: its renewal was refused');
  assert.deepEqual(seen.after, { taken: true, owner: 'driver-blocked', live: true }, 'the next tick retook a live lease for the same driver');
});

test('clause 2: deadWorker reports a driver with a lapsed lease dead only when its pid is gone or a different process [C7]', { timeout: 30_000 }, () => {
  const files = privateFixtureFiles('pullboard-lapsed-board-');
  withFixtureBoard(join(files.root, 'board.sqlite'), board => {
    const lapsedAt = Date.now() - BLOCKED_MS;
    /** Admit a driver whose lease lapsed a minute ago, name the process it ran as, and judge it. */
    const judge = (handoff, driver) => {
      admitGateDrive(board.db, handoff, { owner: `driver-${handoff}`, now: lapsedAt });
      if (driver) recordGateDriveSpawn(board.db, handoff, { owner: `driver-${handoff}`, ...driver, now: lapsedAt });
      const record = readGateDrive(board.db, handoff);
      assert.equal(gateDriverGone(record, Date.now()), true, `${handoff}'s lease lapsed`);
      return deadWorker(record, { id: handoff });
    };
    const exited = spawnSync(process.execPath, ['-e', '']);
    assert.equal(exited.status, 0);
    assert.equal(judge('alive', { pid: process.pid, started: exactStart(process.pid) }), false, 'a live, same driver process is not dead');
    assert.equal(judge('exited', { pid: exited.pid, started: 'gone' }), true, 'an exited driver process is dead');
    assert.equal(judge('reused', { pid: process.pid, started: 'another incarnation' }), true, 'a different process on the pid is dead');
    assert.equal(judge('unnamed', null), true, 'a lapsed driver that named no process is dead');
  });
});

test('clause 3: a worker whose event loop is blocked for 3 minutes finishes with its own verdict, not SUBMIT_HANDOFF_DEAD [C7]', { timeout: 30_000 }, async () => {
  const { last, job, seen, commit } = await blockedDrive();
  assert.equal(seen.blocked.dead, false, 'hand-off recovery never reads the blocked live driver as dead');
  assert.equal(last.phase, 'verdict');
  const collected = job.steps.find(step => step.name === 'collected').payload;
  assert.deepEqual(collected.result, { code: 0, commit }, 'the gate recorded its own green result');
  assert.equal(job.steps.find(step => step.name === 'verdict').payload.verdict, 'green');
  assert.doesNotMatch(JSON.stringify(job.steps), /SUBMIT_HANDOFF_DEAD/u);
});

test('#4073 clause 1: a running hand-off resumes only while its item is claimed by its seat at its digest; otherwise SUBMIT_HANDOFF_CHANGED [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  const added = fixtureAdd(box.run, box.repo, 'web', 'Running hand-off resume', '--specs', 'G1', '--criterion', 'A running hand-off resumes only for its claim.', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id), '--json').code, 0);
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = fixtureOpenBoard(box);
  try {
    const item = getItem(board, id);
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    const queued = store.queueSubmitHandoff(board, id, { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 });
    assert.equal(store.startSubmitHandoff(board, id, { agentId: item.item_owner, job: queued.job.id }).started, true);
    // A driver admitted after a dead one resumes the running record while the item still waits on it.
    const resumed = store.startSubmitHandoff(board, id, { agentId: item.item_owner, job: queued.job.id });
    assert.equal(resumed.started, false);
    assert.equal(resumed.job.state, 'running');
    // The claim moves on: the item is released while its gate runs; the next driver must not resume the old gate.
    // The status guard admits a write only inside a move, so the fixture opens the same window moveItem does.
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare("UPDATE item SET item_status = 'open', item_owner = NULL WHERE item_id = ?").run(id); } // fixture-subject: the item left its claim
    finally { board.db.exec('DELETE FROM temp.moving'); }
    assert.throws(() => store.startSubmitHandoff(board, id, { agentId: item.item_owner, job: queued.job.id }),
      error => error.code === 'SUBMIT_HANDOFF_CHANGED' && /running claim or frozen bar changed/u.test(error.message));
  } finally { board.db.close(); }
});
