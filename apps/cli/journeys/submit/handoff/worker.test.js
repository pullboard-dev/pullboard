/** Launch the real queued-submit process across the lib app's module graph [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { driverRecord } from '../../../tests/fixtures/gate/driver.js';
import { gateSettled } from '../../../tests/fixtures/submit/handoff.js';
import { removeSandboxes } from '../../../tests/fixtures/submit/handoff.js';
import { test } from 'node:test';
import { openBoard } from '../../../../lib/index.js';
import { HOOK_WORKER } from '../../../index.js';
import { gateDriveWorkerEntry } from '../../../src/io/gate/drive.js';
import { admitGateDrive } from '../../../../../packages/drive/index.js';
import { drainLoop } from '../../../../../packages/drive/index.js';
import { gateDriveJobId } from '../../../../../packages/drive/index.js';
import { recordJobRow } from '../../../../../packages/drive/index.js';
import { rowSink } from '../../../../../packages/drive/index.js';
import { createJob } from '../../../../../packages/jobs/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { drivenHandoffGate } from '../../../src/io/submit/handoff/worker.js';
import { getItem } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** Demand a genuine CLI success before reading its native document. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/**
 * A fixture project whose claimed item has a committed page and one native queued submit admitted to a gate driver,
 * as the dispatcher leaves it just before it starts the driver [C7].
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ box: any, board: any, id: number, commit: string, directory: string, request: string, owner: string, job: string, boardFile: string }}
 */
async function admittedGate(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const box = helpers.project('true', isolated);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }));
  writeFileSync(join(box.repo, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('web/page.txt','utf8'),'ready\\n');\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'test: queued worker fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(await fixtureAdd(box.runLocal, box.repo, 'web', 'Real worker process', '--specs', 'G1',
    '--criterion', 'The page is ready.', '--check', 'node check.cjs', '--brief',
    'Files: web/page.txt\nTest: the queued worker submits the committed page.', '--wait', '--json')).item.item_id;
  document(await box.runLocal(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready page [G1]');
  assert.equal(built.status, 0, built.stderr);
  const commonDir = join(box.repo, '.git');
  const boardFile = join(commonDir, 'pullboard/board.sqlite');
  // @pullboard-board-file journey: observe the persisted queue and job rows of the real detached worker
  const board = openBoard(boardFile, undefined, { gitRoot: box.web });
  t.after(() => board.db.close());
  const item = getItem(board, id);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  const queued = writeBoardCommand(board, 'queueSubmitHandoff', [id, {
    agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000,
  }], item.item_owner);
  const directory = join(commonDir, 'pullboard/submit-handoffs', queued.job.id);
  mkdirSync(directory, { recursive: true });
  const request = join(directory, 'request.json');
  writeFileSync(request, JSON.stringify({ item: id, job: queued.job.id, commonDir, commit }));
  // The dispatcher admits the gate to a driver id on the board, then starts the gate driver under it [C7].
  const owner = `test-driver:${queued.job.id}`;
  admitGateDrive(board.db, queued.job.id, { owner });
  return { box, board, id, commit, directory, request, owner, job: queued.job.id, boardFile };
}

/** Submit's own stage names, in the order canonical Submit hands them to its stage runner. */
const SUBMIT_STAGES = ['preflight', 'selection', 'cells', 'doctrine', 'static', 'tests'];

/**
 * The step log a drive job holds as plain data: each step's name, sequence and payload, in the order written.
 *
 * @param {ReturnType<typeof jobView>} view
 */
function stepLog(view) {
  return view.steps.map(({ name, seq, payload }) => ({ name, seq, payload }));
}

/**
 * Queue one real gate for a committed fixture item and launch the real gate driver for it, as the dispatcher does.
 * With `leak`, the driver process loads a module that keeps a handle open forever, the way a leaked board socket did
 * on 4 Nov (#3108), so only an explicit exit ends it.
 *
 * @param {any} t - The running test, for cleanup.
 * @param {{ leak?: boolean }} [options]
 */
async function launchQueuedGate(t, { leak = false } = {}) {
  const { box, board, id, commit, directory, request, owner } = await admittedGate(t);
  const env = { ...box.env };
  if (leak) {
    const leakModule = join(directory, 'leaked-handle.mjs');
    // The leak stays in the driver alone: the gate's own children (git, the check) start without it.
    writeFileSync(leakModule, 'delete process.env.NODE_OPTIONS;\nsetInterval(() => {}, 60_000);\n');
    env.NODE_OPTIONS = `--import=${pathToFileURL(leakModule).href}`;
  }
  // budget: the existing owned-worker hang ceiling; assertions concern exit and native results, not elapsed time.
  // Process-level: the real detached gate driver, run as its own process.
  const result = await runFixtureChildAsync(process.execPath, [gateDriveWorkerEntry(), request, owner],
    { cwd: box.web, env, encoding: 'utf8', timeout: 120_000 });
  return { result, exitedAt: Date.now(), board, id, commit, directory };
}

test('launched gate driver completes a native queued request without unsettled await [V4,H16,E18,C7]', async t => {
  const { result, board, id, commit, directory } = await launchQueuedGate(t);
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.equal(submitHandoff(board, id).state, 'green', result.context);
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(getItem(board, id).item_commit, commit);
  assert.equal(JSON.parse(readFileSync(join(directory, 'submission.json'), 'utf8')).commit, commit);
  assert.equal(existsSync(join(directory, 'source')), false, 'the launched supervisor removes its owned source');
});

/**
 * The gate driver process with two seams: Submit is a stand-in that runs Submit's stage names through the driver
 * (its last stage refuses as a gate red), and the recorder is the real boardRecorder, after which the board file is
 * made unreadable until the recorder closes. Each stage tries to read the board file and reports what it met.
 */
const UNREADABLE_DRIVE = `
const a = JSON.parse(process.env.GATE_ROWS_TEST);
const nativeBoard = await import(a.native);
const worker = await import(a.worker);
const { Refused } = await import(a.kernel);
const { chmodSync, readFileSync } = await import('node:fs');
const files = [a.board, a.board + '-wal', a.board + '-shm'];
const mode = bits => { for (const file of files) { try { chmodSync(file, bits); } catch {} } };
const seen = [];
const record = (board, file) => {
  const recorder = worker.boardRecorder(board, file);
  mode(0);
  return { ...recorder, close: () => { try { recorder.close(); } finally { mode(0o600); } } };
};
const submit = async ctx => {
  await ctx.runGateStages(a.stages.map(name => ({ name, run: async () => {
    try { readFileSync(a.board); seen.push(name + ':readable'); } catch (error) { seen.push(name + ':' + error.code); }
    if (name === 'tests') throw new Refused('GATE_RED', 'the stand-in tests stage is red');
  } })));
};
await worker.driveSubmitHandoff(a.request, { nativeBoard, owner: a.owner, record, submit });
process.stdout.write(JSON.stringify({ seen }));
`;

test('clause 1: a drive run through driveSubmitHandoff holds no board handle: with the board file unreadable to the drive, its step, ticket and verdict rows reach the board through the coordinator-side recorder [C7]', async t => {
  const { box, board, id, request, owner, job, boardFile } = await admittedGate(t);
  const env = { ...box.env, GATE_ROWS_TEST: JSON.stringify({ request, owner, board: boardFile, stages: SUBMIT_STAGES,
    native: new URL('../../../../lib/src/logic/native.js', import.meta.url).href,
    worker: new URL('../../../src/io/submit/handoff/worker.js', import.meta.url).href,
    kernel: new URL('../../../../../packages/kernel/index.js', import.meta.url).href }) };
  // budget: the existing owned-worker hang ceiling; assertions concern the recorded rows, not elapsed time.
  // Process-level: the drive child proves an unreadable board file in a separate process.
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', UNREADABLE_DRIVE],
    { cwd: box.web, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.context);
  const { seen } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(seen, SUBMIT_STAGES.map(name => `${name}:EACCES`), 'every stage ran while the board file was unreadable to the drive');
  const drive = jobView(board.db, gateDriveJobId(job));
  assert.deepEqual(drive.steps.map(step => step.name),
    ['admitted', 'captured', 'running', ...SUBMIT_STAGES.map(() => 'section.done'), 'collected', 'verdict'],
    'after the dispatcher\'s admission, the recorder wrote every step row the drive emitted, in order');
  assert.deepEqual(drive.steps.filter(step => step.name === 'section.done').map(step => [step.payload.section, step.payload.outcome]),
    SUBMIT_STAGES.map(name => [name, name === 'tests' ? 'fail' : 'pass']));
  const verdict = drive.steps.find(step => step.name === 'verdict').payload;
  assert.equal(verdict.verdict, 'red', 'the verdict row reached the board');
  assert.equal(drive.leaseOwner, null, 'the verdict row freed the lease the drive took by its ticket rows');
  assert.equal(drive.step, 'done', 'the coordinator finished the drive job after the verdict');
  const handoff = submitHandoff(board, id);
  assert.equal(handoff.state, 'red', JSON.stringify(handoff));
});

test('clause 2: a real queued gate on a fixture board records its job steps and verdict in order [C7]', async t => {
  const { box, board, id, request, owner, job } = await admittedGate(t);
  // budget: the existing owned-worker hang ceiling; assertions concern the recorded steps, not elapsed time.
  // Process-level: the real detached gate driver, run as its own process.
  const result = await runFixtureChildAsync(process.execPath, [gateDriveWorkerEntry(), request, owner],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.context);
  assert.equal(submitHandoff(board, id).state, 'green');
  const drive = jobView(board.db, gateDriveJobId(job));
  const collected = drive.steps.find(step => step.name === 'collected').payload;
  assert.ok(collected.order.length > 0, 'the gate ran its sections');
  // The gate's test run reports progress while it runs (#3829): those steps sit among the sections and are proved here too.
  assert.ok(drive.steps.some(step => step.name === 'gate.progress' && step.payload.running === true), 'the real test run wrote a running progress step');
  assert.deepEqual(drive.steps.map(step => step.name).filter(name => name !== 'gate.progress'),
    ['admitted', 'captured', 'running', ...collected.order.map(() => 'section.done'), 'collected', 'verdict'],
    'the dispatcher\'s admission, then captured, running, one section step per section, collected and the verdict');
  // Section steps are written as each stage settles, so their sequence is settlement order; each names its place in the gate's order.
  const sections = drive.steps.filter(step => step.name === 'section.done');
  assert.deepEqual(sections.map(step => step.payload.section).sort(), [...collected.order].sort(), 'one section step per gate section');
  assert.deepEqual(sections.map(step => step.payload.index), sections.map(step => collected.order.indexOf(step.payload.section)),
    'each section step names its place in the gate\'s own section order');
  assert.deepEqual(sections.map(step => step.seq), collected.order.map((_, index) => index), 'section steps are numbered in the order written');
  assert.equal(collected.result.code, 0);
  assert.equal(drive.steps.at(-1).payload.verdict, 'green');
  assert.equal(drive.step, 'done');
});

test('clause 2: a gate driven over rows to the recorder writes the same job steps and verdict, in order, as a gate driven on the board handle [C7]', async t => {
  const { box, board, commit } = await admittedGate(t);
  /** A stand-in for canonical Submit whose stages run in Submit's order and whose tests stage is red. */
  const submit = async ctx => {
    await ctx.runGateStages(SUBMIT_STAGES.map(name => ({ name, run: async () => {
      if (name === 'tests') throw new Refused('GATE_RED', 'the stand-in tests stage is red');
    } })));
  };
  /** Drive one whole-gate job to its verdict, on the board handle or over rows. */
  const drive = async (id, rows) => {
    createJob(board.db, { id, kind: 'gate', item: 1, candidate: commit, base: commit, now: 1 });
    const gate = drivenHandoffGate({}, { item: 1 }, { waitInventory: async () => null, submit });
    const target = rows ? rowSink(jobView(board.db, id), row => recordJobRow(board.db, row)) : board.db;
    const last = await drainLoop(target, id, { owner: 'driver-rows', repo: box.web, gate, intervalMs: 0, now: () => 5_000 });
    assert.equal(last.phase, 'verdict');
    return stepLog(jobView(board.db, id));
  };
  const before = await drive('gate-board-handle', false);
  const after = await drive('gate-row-sink', true);
  assert.deepEqual(before.map(step => step.name), ['captured', 'running', ...SUBMIT_STAGES.map(() => 'section.done'), 'collected', 'verdict']);
  assert.deepEqual(after, before, 'the same steps, sequences and payloads, in the same order');
  assert.equal(after.at(-1).payload.verdict, 'red');
  assert.equal(jobView(board.db, 'gate-row-sink').leaseOwner, null, 'the verdict row frees the lease as the board-handle verdict does');
});

test('clause 1: a gate driver that recorded its terminal result exits within 30 s despite a leaked handle, freeing its slot [C7]', async t => {
  const { result, exitedAt, board, id } = await launchQueuedGate(t, { leak: true });
  assert.equal(result.status, 0, result.context);
  const job = submitHandoff(board, id);
  assert.equal(job.state, 'green', JSON.stringify(job));
  // budget: the criterion's 30 s bound from the recorded terminal result to the process's exit.
  assert.ok(exitedAt - Date.parse(job.completedAt) < 30_000, `exited ${exitedAt - Date.parse(job.completedAt)} ms after its result`);
});

test('resubmitting an orphaned queue without request or worker launches a fresh captured job [V4,H16,E18]', async t => {
  const helpers = createE2eHelpers();
  let box;
  let fresh;
  t.after(async () => {
    // The fresh driver and its dispatcher still write for a moment after the job ends; remove the tree once they are done.
    try { if (box) await gateSettled(helpers, box, fresh); }
    finally { await removeSandboxes(helpers); }
  });
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  box = helpers.project('true', isolated);
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }));
  writeFileSync(join(box.repo, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('web/page.txt','utf8'),'ready\\n');\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'test: orphaned queued worker fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(await fixtureAdd(box.runLocal, box.repo, 'web', 'Orphaned worker recovery', '--route', 'strong', '--specs', 'G1',
    '--criterion', 'The fresh worker submits the committed page.', '--check', 'node check.cjs',
    '--brief', 'Files: web/page.txt\nTest: a resubmit replaces a queue that has no worker.', '--wait', '--json')).item.item_id;
  document(await box.runLocal(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready orphaned worker fixture [G1]').status, 0);
  const boardPath = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: observe the persisted queue and job rows of the real detached worker
  const board = openBoard(boardPath, undefined, { gitRoot: box.web });
  let orphan;
  try {
    const item = getItem(board, id);
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
    orphan = writeBoardCommand(board, 'queueSubmitHandoff', [id, {
      agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
      commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
      companionDigest: null, leaseMs: 7_200_000,
    }], item.item_owner).job;
  } finally { board.db.close(); }
  const orphanDirectory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', orphan.id);
  mkdirSync(orphanDirectory, { recursive: true });

  const retried = document(await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.equal(retried.queued, true);
  // @pullboard-board-file journey: observe the persisted queue and job rows of the real detached worker
  const currentBoard = openBoard(boardPath, undefined, { gitRoot: box.web });
  let current;
  try { current = submitHandoff(currentBoard, id); }
  finally { currentBoard.db.close(); }
  fresh = current.id;
  assert.notEqual(current.id, orphan.id, 'the dead queue is closed before the same candidate gets a new identity');
  // The replacement's detached worker starts at once, so by the time this read runs the job may already be running or finished.
  assert.ok(['queued', 'running', 'green'].includes(current.state), `the replacement is a live job: ${current.state}`);
  const refusal = JSON.parse(readFileSync(join(orphanDirectory, 'refusal.json'), 'utf8'));
  assert.equal(refusal.error.code, 'SUBMIT_HANDOFF_NOT_LAUNCHED');
  assert.match(refusal.error.message, /request\.json and its driver record are missing/u);
  const freshDirectory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.id);
  await helpers.waitFor(() => driverRecord(boardPath, current.id)?.pid > 0, 'fresh gate driver record', 30000); // budget: owned driver launch ceiling, no timing claim.
  const request = JSON.parse(readFileSync(join(freshDirectory, 'request.json'), 'utf8'));
  assert.equal(request.job, current.id);
  assert.equal(request.commit, current.commit);
  assert.equal(existsSync(request.tools), true, 'the replacement job owns its captured tool snapshot');
  // The original whole-file gate took 124.6 s while its isolated diagnostic took 100.5 s; allow
  // normal queue variation so this checks eventual completion rather than the runner's speed.
  const completed = await helpers.waitFor(() => { // budget: real worker completion ceiling, not an elapsed-time assertion.
    // @pullboard-board-file journey: observe the persisted queue and job rows of the real detached worker
    const observed = openBoard(boardPath, undefined, { gitRoot: box.web });
    try {
      const job = submitHandoff(observed, id);
      return job && !['queued', 'running'].includes(job.state) ? job : false;
    } finally { observed.db.close(); }
  }, 'fresh worker completion after an orphaned queue', 120000); // budget: owned-worker completion ceiling; no elapsed-time claim.
  assert.equal(completed.state, 'green', JSON.stringify(completed));
});

test('launched hook worker inspects committed work without unsettled await [I6,C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = document(await fixtureAdd(box.runLocal, box.repo, 'web', 'Hook process work',
    '--criterion', 'The committed work is named.', '--json')).item.item_id;
  document(await box.runLocal(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready page [G1]');
  assert.equal(built.status, 0, built.stderr);
  // budget: existing owned-child hang ceiling; successful inspection and native exit are the assertions.
  // Process-level: a real hook worker child, run as the hook runs it.
  const result = await runFixtureChildAsync(process.execPath, [HOOK_WORKER, 'Stop'],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.match(result.stdout, new RegExp(`Committed work on #${id} is not submitted`, 'u'));
});
