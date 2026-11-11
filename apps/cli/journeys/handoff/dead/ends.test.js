/** One health sweep ends a submit handoff whose worker is gone, whichever seat queued it and whatever its item's state [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  driverRecord,
  setDriverProcess,
  spendDriverRelaunches,
} from '../../../tests/fixtures/gate/driver.js';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { gateSettled } from '../../../tests/fixtures/submit/handoff.js';
import { removeSandboxes } from '../../../tests/fixtures/submit/handoff.js';
import { openBoard } from '../../../../lib/index.js';
import * as nativeBoard from '../../../../lib/index.js';
import { recoverInfrastructureHandoffs } from '../../../src/io/submit/handoff.js';
import { RUNNING_RELAUNCH_LIMIT } from '../../../src/io/submit/handoff.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { writeBoardCommand } from '../../../../../packages/store/index.js';
import { randomUUID } from 'node:crypto';
import { INFRASTRUCTURE_CODES } from '../../../../lib/index.js';
import { INFRASTRUCTURE_CODES as boardCodes } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { endedSubmitHandoff } from '../../../../../packages/store/index.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state the separate worker wrote, without writing anything. */
function state(box, id, endedId) {
  // @pullboard-board-file journey: observe the detached worker's actual persisted queue record.
  const board = openBoard(box.boardFile);
  try { return { item: getItem(board, id), job: submitHandoff(board, id),
    ended: endedId ? endedSubmitHandoff(board, endedId) : null,
    returns: board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE item_id=? AND event_kind='submit_handoff_returned'").get(id).n }; }
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
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Swept dead handoff', '--route', 'strong', '--specs', 'G1',
    '--criterion', 'A dead handoff ends within one sweep.', '--check', `${word(process.execPath)} ${word(script)}`, '--wait', '--json')).item.item_id;
  document(box.run(box.repo, 'fact', String(id), 'diagnosis',
    'Files: web/snapshot.txt Change: hold and release a real submitted gate Test case: one sweep retires the handoff without returning a builder red', '--json'));
  document(box.run(box.web, 'claim', String(id), '--json'));
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => !['queued', 'running'].includes(state(box, id).job?.state), 'queued worker finished', 120000); // budget: cleanup ceiling, no timing assertion.
    // The driver and dispatcher still write for a moment after the job ends; remove the tree only once they are done.
    await gateSettled(helpers, box, state(box, id).job?.id);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, id, started, release };
}

/** Start a held gate for the item, then kill its worker's whole process group, as a crash would. */
async function killedRunningHandoff(box, { spend = true } = {}) {
  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'hold\n', 'feat(web): held candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).queued, true);
  await box.helpers.waitFor(() => existsSync(box.started) && state(box, box.id).job?.state === 'running', 'the gate is running', 120000); // budget: real worker start ceiling, no timing assertion.
  const job = state(box, box.id).job;
  sweep(box);
  assert.equal(state(box, box.id).job.id, job.id, 'a live worker is never replaced');
  await killWorker(box, job, { spend });
  return job;
}

/** Kill only this fixture's recorded detached group and observe its actual exit, not a fabricated pid. */
async function killWorker(box, job, { spend = true } = {}) {
  const owner = driverRecord(box.boardFile, job.id);
  process.kill(-owner.pid, 'SIGKILL');
  await box.helpers.waitFor(() => gone(owner.pid), 'the worker is gone', 120000); // budget: kill ceiling, no timing assertion.
  // Relaunching a dead running gate comes first (#3995); a worker that keeps dying has spent that budget before the sweep ends it.
  if (spend) spendDriverRelaunches(box.boardFile, job.id, RUNNING_RELAUNCH_LIMIT);
  assert.equal(state(box, box.id).job.state, 'running', 'the dead worker left its job marked running');
}

/** Run one health sweep as the coordinator, from the main checkout; no command by the item's seat runs. */
function sweep(box) {
  const run = box.run(box.repo, 'sentinel', 'run', '--health-only');
  assert.equal(run.code, 0, `${run.err}\n${run.out}`);
}

test('clause 1: one sweep ends a killed worker as infrastructure and retries its exact candidate without builder red [C7,V4]', async t => {
  const box = fixture(t);
  const job = await killedRunningHandoff(box);
  const before = state(box, box.id).item;
  const owner = driverRecord(box.boardFile, job.id);
  setDriverProcess(box.boardFile, job.id, { pid: process.pid, started: null });
  sweep(box);
  assert.equal(state(box, box.id).job.id, job.id, 'an unreadable live incarnation is left alone');
  assert.equal(state(box, box.id).job.state, 'running');
  setDriverProcess(box.boardFile, job.id, { pid: owner.pid, started: owner.started });
  sweep(box);
  const after = state(box, box.id, job.id);
  assert.equal(after.ended.state, 'infrastructure', 'native history reports the stopped incarnation within one sweep');
  assert.equal(after.ended.error.code, 'SUBMIT_HANDOFF_DEAD');
  assert.notEqual(after.job.id, job.id, 'the old worker cannot write for its successor');
  for (const field of ['commit', 'tree', 'main', 'executionCommit', 'executionTree', 'digest', 'companionDigest']) {
    assert.equal(after.job[field], job[field], `same-candidate recovery preserves ${field}`);
  }
  assert.equal(after.job.infrastructureRetries, 1);
  assert.equal(after.item.item_status, 'claimed');
  assert.equal(after.item.item_owner, before.item_owner);
  assert.equal(after.item.item_lease_until, before.item_lease_until, 'recovery does not replace or renew the claim');
  assert.equal(after.returns, 0, 'no builder-red return is recorded');
  writeFileSync(box.release, 'release\n');
  // The worker records the job green and then moves the item in a later write, so wait for both before reading either.
  await box.helpers.waitFor(() => { const seen = state(box, box.id); return ['green', 'submitted'].includes(seen.job?.state) && seen.item.item_status === 'submitted'; }, 'the recovered candidate finishes and the item is submitted', 120000); // budget: worker completion ceiling, no timing assertion.
  assert.equal(state(box, box.id).item.item_status, 'submitted');
  assert.equal(state(box, box.id).job.commit, job.commit, 'no builder command or newer source was required');
});

test('a dead handoff on an item its seat no longer holds also ends within one sweep [C7,V4]', async t => {
  const box = fixture(t);
  const job = await killedRunningHandoff(box, { spend: false });
  const released = box.run(box.web, 'release', String(box.id), '--reason', 'OTHER', '--note', 'fixture releases the item', '--no-next');
  assert.equal(released.code, 0, `${released.err}\n${released.out}`);
  assert.notEqual(state(box, box.id).item.item_status, 'claimed');
  assert.equal(state(box, box.id).job.state, 'running', 'releasing the item left the dead job running');
  sweep(box);
  const after = state(box, box.id).job;
  assert.equal(after.id, job.id);
  assert.equal(after.error?.code, 'SUBMIT_HANDOFF_DEAD');
  assert.equal(after.state, 'infrastructure');
  assert.equal(state(box, box.id).returns, 0);
});


test('three same-candidate crash retries are bounded and exhaustion stays infrastructure [C7,V4]', async t => {
  const box = fixture(t);
  let job = await killedRunningHandoff(box);
  const commit = job.commit;
  for (let retry = 1; retry <= 3; retry += 1) {
    sweep(box);
    const next = state(box, box.id, job.id);
    assert.equal(next.ended.state, 'infrastructure');
    assert.equal(next.job.infrastructureRetries, retry);
    assert.equal(next.job.commit, commit);
    assert.notEqual(next.job.id, job.id);
    job = next.job;
    await box.helpers.waitFor(() => state(box, box.id).job?.state === 'running', 'the recovery worker runs', 120000); // budget: real worker readiness ceiling, no timing assertion.
    await killWorker(box, job);
  }
  sweep(box);
  const after = state(box, box.id, job.id);
  assert.equal(after.job.id, job.id, 'no fourth retry is queued');
  assert.equal(after.job.state, 'infrastructure');
  assert.equal(after.job.infrastructureRetries, 3);
  assert.equal(after.job.error.code, 'SUBMIT_HANDOFF_DEAD');
  assert.equal(after.item.item_status, 'claimed');
  assert.equal(after.returns, 0, 'infrastructure never becomes a builder red');
});


test('clause 2: an infrastructure-stopped candidate waits for health, retries three times, and notifies once without builder red [C7,V4]', async t => {
  const box = fixture(t);
  let job = await killedRunningHandoff(box);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  /** Retain the actual canonical infrastructure refusal through the native board command. */
  function stop(current, code) {
    return writeBoardCommand(board, 'completeSubmitHandoff', [box.id, { agentId: current.agentId, job: current.id,
      result: { code: 1, error: { code, message: 'fixture executor exhausted infrastructure retries', next: 'restore the executor' } } }], current.agentId);
  }
  try {
    stop(job, 'GATE_INFRA_EXHAUSTED');
    const ctx = { file: box.boardFile, info: { root: box.repo, commonDir: join(box.repo, '.git'), isMain: true },
      config: loadConfig(box.repo), clock: { now: () => new Date() }, nativeBoard, io: { err() {} } };
    assert.equal(await recoverInfrastructureHandoffs(ctx, { healthy: async () => false,
      launch: async () => assert.fail('an unhealthy executor must not launch') }), 0);
    assert.equal(state(box, box.id).job.id, job.id);
    for (let retry = 1; retry <= 3; retry++) {
      sweep(box);
      const next = state(box, box.id, job.id);
      assert.equal(next.ended.state, 'infrastructure');
      assert.equal(next.job.infrastructureRetries, retry);
      for (const field of ['commit', 'tree', 'main', 'executionCommit', 'executionTree', 'digest', 'companionDigest']) {
        assert.equal(next.job[field], job[field], `recovery preserves ${field}`);
      }
      job = next.job;
      await box.helpers.waitFor(() => state(box, box.id).job?.state === 'running', 'recovered worker runs', 120000); // budget: real worker readiness ceiling, no timing assertion.
      await killWorker(box, job);
      stop(job, 'GATE_INFRA_EXHAUSTED');
    }
    sweep(box);
    sweep(box);
    const after = state(box, box.id);
    assert.equal(after.job.id, job.id);
    assert.equal(after.job.state, 'infrastructure');
    assert.equal(after.item.item_status, 'claimed');
    assert.equal(after.returns, 0);
    const notices = board.db.prepare("SELECT shout_text FROM shout WHERE shout_to='coordinator'").all()
      .filter(row => row.shout_text.includes(`Queued gate #${box.id} exhausted 3 healthy-executor recovery retries`));
    assert.equal(notices.length, 1);
  } finally { board.db.close(); }
});

test('clause 3: board and worker share infrastructure codes, including runner retry exhaustion which never returns builder red [C7,V4]', t => {
  assert.deepEqual([...INFRASTRUCTURE_CODES].sort(), [...boardCodes].sort());
  assert.ok(boardCodes.has('RUNNER_INFRA_RETRY_EXHAUSTED'));
  const box = fixture(t);
  assert.equal(box.helpers.commitFile(box, box.web, 'web/snapshot.txt', 'ready\n', 'feat(web): infrastructure fixture candidate [G1]').status, 0);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    const item = getItem(board, box.id);
    const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      executionCommit: box.git(box.web, 'rev-parse', 'HEAD'), executionTree: box.git(box.web, 'rev-parse', 'HEAD^{tree}'),
      digest: item.item_frozen_digest, companionDigest: null, leaseMs: 7_200_000 };
    const queued = writeBoardCommand(board, 'queueSubmitHandoff', [box.id, options], item.item_owner);
    const done = writeBoardCommand(board, 'completeSubmitHandoff', [box.id, { agentId: item.item_owner, job: queued.job.id,
      result: { code: 1, error: { code: 'RUNNER_INFRA_RETRY_EXHAUSTED', message: 'executor retries exhausted', next: 'restore runner' } } }], item.item_owner);
    assert.equal(done.state, 'infrastructure');
    assert.equal(state(box, box.id).returns, 0);
    assert.equal(getItem(board, box.id).item_status, 'claimed');
  } finally { board.db.close(); }
});

test('clause 1: a stopped job whose captured tools are gone spends its retries and notifies the coordinator once [C7,V4]', async t => {
  const box = fixture(t);
  const job = await killedRunningHandoff(box);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, undefined, { gitRoot: box.web });
  try {
    writeBoardCommand(board, 'completeSubmitHandoff', [box.id, { agentId: job.agentId, job: job.id,
      result: { code: 1, error: { code: 'SUBMIT_HANDOFF_DEAD', message: 'fixture worker died', next: 'restore the executor' } } }], job.agentId);
    const requestFile = join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'request.json');
    const request = JSON.parse(readFileSync(requestFile, 'utf8'));
    rmSync(request.tools, { recursive: true, force: true });
    // Since #3716 a retry rebuilds vanished tools from the tooling commit its request captured; with no such commit they are truly gone.
    delete request.toolsCommit;
    writeFileSync(requestFile, JSON.stringify(request) + '\n');
    const ctx = { file: box.boardFile, info: { root: box.repo, commonDir: join(box.repo, '.git'), isMain: true },
      config: loadConfig(box.repo), clock: { now: () => new Date() }, nativeBoard, io: { err() {} } };
    for (let sweeps = 0; sweeps < 3; sweeps++) await recoverInfrastructureHandoffs(ctx, { healthy: async () => true, launch: async () => assert.fail('no tools, no launch') });
    const after = state(box, box.id);
    assert.equal(after.job.id, job.id);
    assert.equal(after.job.infrastructureRetries, 3);
    assert.equal(after.returns, 0);
    const notices = board.db.prepare("SELECT shout_text FROM shout WHERE shout_to='coordinator'").all()
      .filter(row => row.shout_text.includes(`Queued gate #${box.id} exhausted 3 healthy-executor recovery retries`));
    assert.equal(notices.length, 1);
  } finally { board.db.close(); }
});
