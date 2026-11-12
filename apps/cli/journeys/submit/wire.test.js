/** @pullboard-test-input source-tree */
/** @pullboard-world-pin: the save and cut cases read the shipped source to prove the old paths are gone. */
/** Durable wiring: production runs on the jobs and drive cells, and the old hand-off and landing paths are gone [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  relative,
} from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  closeBoard,
} from '../../../lib/src/logic/native.js';
import * as store from '../../../../packages/store/index.js';
import {
  recordSubmitHandoff,
  jobView,
  takeJob,
} from '../../../../packages/jobs/index.js';
import {
  DISPATCHER_JOB,
  driveLanding,
  ensureDispatcher,
  gateDriveJobId,
  readGateDrive,
} from '../../../../packages/drive/index.js';
import {
  drainHandoffQueue,
  queueHandoffLaunch,
  reserveHandoffTicket,
} from '../../../../packages/resources/index.js';
import {
  inProcessLandingBatch,
  landingProgress,
} from '../../../../packages/landing/index.js';
import {
  dispatcherRow,
  gateAdmission,
} from '../../../lib/src/io/handoff/dispatcher.js';
import {
  fixtureBoard,
  temporaryDirectory,
} from '../../tests/fixtures/board.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';
import { withFixtureBoard } from '../../tests/fixtures/testkit.js';
import { readText } from '../../../../packages/gate/src/io/scan.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** Point the machine home at a private directory for one test. */
function machineHome(t, home) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
}

test('clause 1: board-query, item-stage, red-return-lease and the listers read submit state from the job tables, not board_meta [C7]', t => {
  const board = fixtureBoard(t);
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Read the gate from its job' });
  board.db.prepare('UPDATE item SET item_frozen_digest = ? WHERE item_id = ?').run('digest', id);
  const error = { code: 'GATE_RED', message: 'The proof is red.', next: 'Fix it.' };
  recordSubmitHandoff(board.db, id, { version: 1, id: 'wire-job', agentId: 'core-1', commit: 'c'.repeat(40), digest: 'digest', state: 'red', error });
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key GLOB 'submit_handoff*'").get().n, 0, 'no board_meta copy exists');
  assert.equal(store.getItem(board, id).item_stage, 'back with builder', 'getItem reads the job record');
  assert.equal(store.listItems(board).find(item => item.item_id === id).item_stage, 'back with builder', 'listItems reads the job record');
  assert.equal(store.stageCounts(board)['back with builder'], 1, 'stage counts read the job record');
  assert.deepEqual(store.submitHandoffFailure(board, store.getItem(board, id)), error, 'the refusal is read from the job');
  assert.deepEqual([...store.handoffRecords(board.db).keys()], [id], 'the sweep listers see the item from the job tables');
});

test('clause 1: submit enqueues its gate as a jobs-cell job and save() writes no board_meta row [C7]', t => {
  const source = readFileSync(join(ROOT, 'packages/store/src/io/submit/handoff/retry.js'), 'utf8');
  assert.doesNotMatch(source, /board_meta/u, 'the hand-off state writes nothing to board_meta');
  assert.match(source, /function save\(board, id, job\) \{\n  const write = board\.enginePorts\?\.shadowJob;/u, 'save goes through the jobs cell port');
  const board = fixtureBoard(t);
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Queue as a job' });
  recordSubmitHandoff(board.db, id, { version: 1, id: 'queued-job', agentId: 'core-1', commit: 'c'.repeat(40), state: 'queued' });
  const view = jobView(board.db, 'queued-job');
  assert.equal(view.kind, 'gate');
  assert.equal(view.item, id);
  assert.equal(view.steps.at(-1).payload.record.state, 'queued', 'the queue is the gate job and its first step');
});

test('clause 1: the dispatcher runs each gate through a drive-cell driver under a jobs-cell row, with no worker launch and no worker.json [C7]', async t => {
  const dir = temporaryDirectory('pullboard-durable-wire-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  machineHome(t, join(dir, 'home'));
  const { commonDir, item } = (await setupServingHandoff(t));


  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'bin'), { recursive: true });
  // A gate driver that records the owner it was admitted under and its result, then exits.
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), `const { writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
writeFileSync(join(dirname(process.argv[2]), 'driver.txt'), process.argv[3]);
writeFileSync(join(dirname(process.argv[2]), 'submission.json'), '{}');
`);
  const directory = join(dir, 'jobs', 'wire-gate');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'wire-gate', item }) + '\n');
  queueHandoffLaunch({ directory, tools, commonDir, job: 'wire-gate' }, await reserveHandoffTicket('wire-gate'));
  const { started } = await drainHandoffQueue({ capacity: 1, pollMs: 20, admission: gateAdmission });
  assert.deepEqual(started, ['wire-gate']);
  const owner = readFileSync(join(directory, 'driver.txt'), 'utf8');
  const board = openKitBoard(join(commonDir, 'pullboard', 'board.sqlite'));
  try {
    const record = readGateDrive(board.db, 'wire-gate');
    assert.equal(record.owner, owner, 'the driver runs under the owner its drive job admitted');
    assert.ok(record.pid > 0, 'the drive job records the process the dispatcher started');
    assert.equal(jobView(board.db, gateDriveJobId('wire-gate')).kind, 'gate-drive');
    // The dispatcher row: a submit takes it when lapsed, a live row launches nothing, and the dispatcher frees it.
    let launches = 0;
    const first = ensureDispatcher(board.db, { owner: 'submit-a', spawn: () => { launches += 1; } });
    const second = ensureDispatcher(board.db, { owner: 'submit-b', spawn: () => { launches += 1; } });
    assert.deepEqual([first.spawned, second.spawned, launches], [true, false, 1]);
  } finally { closeBoard(board); }
  dispatcherRow(commonDir, 'submit-a').release();
  const freed = openKitBoard(join(commonDir, 'pullboard', 'board.sqlite'));
  try { assert.equal(jobView(freed.db, DISPATCHER_JOB).leaseOwner, null, 'a drained dispatcher frees its row'); }
  finally { closeBoard(freed); }
  assert.equal(existsSync(join(directory, 'worker.json')), false, 'nothing is written beside the hand-off');
});

test('clause 1: a stalled in-process landing ends after 10 minutes without progress, its job failed with the lease freed [C7]', async t => {
  const board = fixtureBoard(t);
  let clock = 0;
  const now = () => clock;
  const progress = landingProgress({ now });
  const batch = { id: 'batch-stall', state: 'testing', revision: 1 };
  let hung;
  const runner = inProcessLandingBatch({ checkAtCommit: () => {}, candidateWorkerFile: 'unused', progress,
    // A batch that records itself, then hangs on a child that never ends.
    runLandingBatch: async options => { await options.write('recordLandingBatch', [{ batch }]); return new Promise(resolve => { hung = resolve; }); } });
  const hooks = { board, landingPorts: {}, checkLease: async () => {}, checkLeaseNow: () => {}, say: () => {},
    write: async (_operation, args) => args[0].batch,
    onStall: async ({ description }) => ({ batch: { ...batch, state: 'blocked' }, landed: [], stalled: true, stallDescription: description }) };
  const id = 'land:run:stall';
  // Count the heartbeat's progress reads, so the test waits on observed beats, never on elapsed time.
  let beats = 0;
  const lastProgressAt = () => { beats += 1; return progress.lastProgressAt(); };
  /** Resolve once the heartbeat has read progress `more` more times. */
  const beatsPass = async more => { const until = beats + more; while (beats < until) await new Promise(resolve => setImmediate(resolve)); };
  const landing = driveLanding(board.db, { owner: 'lander', id, now, renewMs: 1,
    watch: { lastProgressAt, stall: progress.stall }, run: () => runner({ fence: {}, root: '/unused' }, hooks) });
  await beatsPass(1);
  clock = 9 * 60_000;
  await beatsPass(2);
  assert.equal(jobView(board.db, id).steps.some(step => step.name === 'failed'), false, 'nine quiet minutes do not end the batch');
  clock = 10 * 60_000;
  // The heartbeat timer is unref'd, as in production, so the test keeps the loop turning until the landing settles.
  let settled = false;
  landing.finally(() => { settled = true; }).catch(() => {});
  while (!settled) await new Promise(resolve => setImmediate(resolve));
  const result = await landing;
  assert.equal(result.stalled, true, 'the batch ended as stalled');
  const view = jobView(board.db, id);
  const failed = view.steps.find(step => step.name === 'failed');
  assert.equal(failed?.payload.code, 'LAND_STALLED', 'the landing-run job is marked failed');
  assert.equal(view.leaseOwner, null, 'its lease is freed');
  assert.equal(takeJob(board.db, id, 'next-lander', { now: clock }).taken, true, 'the next landing can start');
  hung?.();
});

test('clause 2: the old hand-off worker launch, worker.json, board_meta hand-off rows and the landing worker spawn path are gone [C7]', () => {
  assert.equal(existsSync(join(ROOT, 'bin/landing-worker.js')), false, 'bin/landing-worker.js is deleted');
  /** Every source file under the product folders, skipping tests. */
  const sources = [];
  const walk = folder => {
    for (const entry of readdirSync(join(ROOT, folder), { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (!['tests', 'node_modules', 'cell-lint-baselines', 'cells-plan'].includes(entry.name)) walk(path); }
      else if (/\.js$/u.test(entry.name) && !/\.test\.js$/u.test(entry.name)) sources.push(path);
    }
  };
  for (const folder of ['apps', 'packages', 'bin', 'src']) if (existsSync(join(ROOT, folder))) walk(folder);
  const offenders = (pattern, allowed = []) => sources.filter(path => !allowed.includes(relative(ROOT, join(ROOT, path)))
    && pattern.test(readText(ROOT, path)));
  assert.deepEqual(offenders(/submit-handoff-worker\.js'\)?,\s*join\(launch\.directory/u), [], 'the dispatcher never launches the hand-off worker');
  assert.deepEqual(offenders(/'worker\.json'/u, ['packages/verify/src/io/comparison.js']), [], 'no hand-off module reads or writes worker.json');
  assert.deepEqual(offenders(/'submit_handoff:'\s*\+|`submit_handoff:\$\{|meta_key GLOB 'submit_handoff/u), [], 'no module reads or writes board_meta hand-off rows');
  assert.deepEqual(offenders(/runLandingWorker|landingWorkerEntry|superviseSubmitHandoffWorker|runSubmitHandoffWorker/u), [], 'nothing names the old worker entries');
});

test('clause 1: the comparison restart plan reads the worker record through comparison-worker.js with no allowlist entry [C7]', () => {
  const plan = readFileSync(join(ROOT, 'packages/verify/src/io/compare.js'), 'utf8');
  assert.doesNotMatch(plan, /'worker\.json'/u, 'the restart plan names no worker.json literal');
  assert.match(plan, /COMPARISON_WORKER_RECORD/u, 'the plan reads the record name the worker module exports');
  assert.match(readFileSync(join(ROOT, 'packages/verify/src/io/comparison.js'), 'utf8'), /COMPARISON_WORKER_RECORD = 'worker\.json'/u);
});

test('clause 3: two drivers writing steps on one board never fail with database is locked [C7]', async t => {
  const dir = temporaryDirectory('pullboard-durable-lock-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.sqlite');
  closeBoard(openKitBoard(file));
  // Each driver reads its job's step log and writes the next step, 300 times, against the other on the same file.
  const driver = name => `import { openBoard, closeBoard } from ${JSON.stringify(join(ROOT, 'apps/lib/index.js'))};
import { createJob, writeStep } from ${JSON.stringify(join(ROOT, 'packages/jobs/index.js'))};
const board = openBoard(${JSON.stringify(file)});
try {
  createJob(board.db, { id: ${JSON.stringify(name)}, kind: 'gate' });
  for (let seq = 0; seq < 300; seq += 1) writeStep(board.db, ${JSON.stringify(name)}, 'shard.done', { seq }, { seq });
} finally { closeBoard(board); }`;
  const runs = await Promise.all(['driver-a', 'driver-b'].map(name =>
    runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', driver(name)], { encoding: 'utf8' })));
  for (const run of runs) {
    assert.doesNotMatch(run.stderr ?? '', /database is locked/u, run.context);
    assert.equal(run.status, 0, run.context);
  }
  const board = openKitBoard(file);
  try { for (const name of ['driver-a', 'driver-b']) assert.equal(jobView(board.db, name).steps.length, 300, `${name} wrote every step`); }
  finally { closeBoard(board); }
});

/** Seed a real claimed item and its queued handoff through the shared fixture seams. */
async function setupServingHandoff(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Wire fixture gate', '--specs', 'G1', '--criterion', 'The wire gate serves its item.', '--check', 'true', '--json'));
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claimed = (await box.runLocal(box.web, 'claim', String(item), '--json'));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const commonDir = join(box.repo, '.git');
  withFixtureBoard(join(commonDir, 'pullboard', 'board.sqlite'), board => {
    const current = store.getItem(board, item);
    recordSubmitHandoff(board.db, item, { version: 1, id: 'wire-gate', agentId: current.item_owner, commit: 'c'.repeat(40), digest: current.item_frozen_digest, state: 'queued' });
    assert.equal(store.handoffServes(board, item, 'wire-gate'), true, 'the real queued handoff serves its claimed item');
  });
  return { commonDir, item };
}
