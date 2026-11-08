/** Launch the real queued-submit process across the lib app's module graph [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { driverRecord } from '../../../test/gate-driver-fixture.js';
import { gateSettled } from '../../../test/submit-handoff-fixture.js';
import { removeSandboxes } from '../../../test/submit-handoff-fixture.js';
import { test } from 'node:test';
import { openBoard } from '../index.js';
import { HOOK_WORKER } from '../index.js';
import { gateDriveWorkerEntry } from '../../../bin/gate-drive-worker.js';
import { admitGateDrive } from '../../../packages/drive/index.js';
import { getItem } from '../../../packages/store/index.js';
import { submitHandoff } from '../../../packages/store/index.js';
import { writeBoardCommand } from '../../../packages/store/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { runFixtureChildAsync } from '../../../test/fixture-child.js';
import { fixtureAdd } from '../../../test/testkit-fixture.js';

/** Demand a genuine CLI success before reading its native document. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
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
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Real worker process', '--specs', 'G1',
    '--criterion', 'The page is ready.', '--check', 'node check.cjs', '--brief',
    'Files: web/page.txt\nTest: the queued worker submits the committed page.', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready page [G1]');
  assert.equal(built.status, 0, built.stderr);
  const commonDir = join(box.repo, '.git');
  const board = openBoard(join(commonDir, 'pullboard/board.sqlite'), undefined, { gitRoot: box.web });
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
  const env = { ...box.env };
  if (leak) {
    const leakModule = join(directory, 'leaked-handle.mjs');
    // The leak stays in the driver alone: the gate's own children (git, the check) start without it.
    writeFileSync(leakModule, 'delete process.env.NODE_OPTIONS;\nsetInterval(() => {}, 60_000);\n');
    env.NODE_OPTIONS = `--import=${pathToFileURL(leakModule).href}`;
  }
  // budget: the existing owned-worker hang ceiling; assertions concern exit and native results, not elapsed time.
  const result = await runFixtureChildAsync(process.execPath, [gateDriveWorkerEntry(), request, owner],
    { cwd: box.web, env, encoding: 'utf8', timeout: 120_000 });
  return { result, exitedAt: Date.now(), board, id, commit, directory };
}

test('launched gate driver completes a native queued request without unsettled await [V4,H16,E18,C7]', async t => {
  const { result, board, id, commit, directory } = await launchQueuedGate(t);
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.equal(submitHandoff(board, id).state, 'green');
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(getItem(board, id).item_commit, commit);
  assert.equal(JSON.parse(readFileSync(join(directory, 'submission.json'), 'utf8')).commit, commit);
  assert.equal(existsSync(join(directory, 'source')), false, 'the launched supervisor removes its owned source');
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
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Orphaned worker recovery', '--route', 'strong', '--specs', 'G1',
    '--criterion', 'The fresh worker submits the committed page.', '--check', 'node check.cjs',
    '--brief', 'Files: web/page.txt\nTest: a resubmit replaces a queue that has no worker.', '--wait', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready orphaned worker fixture [G1]').status, 0);
  const boardPath = join(box.repo, '.git', 'pullboard', 'board.sqlite');
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

  const retried = document(box.run(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.equal(retried.queued, true);
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
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Hook process work',
    '--criterion', 'The committed work is named.', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/page.txt', 'ready\n', 'feat(web): ready page [G1]');
  assert.equal(built.status, 0, built.stderr);
  // budget: existing owned-child hang ceiling; successful inspection and native exit are the assertions.
  const result = await runFixtureChildAsync(process.execPath, [HOOK_WORKER, 'Stop'],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.match(result.stdout, new RegExp(`Committed work on #${id} is not submitted`, 'u'));
});
