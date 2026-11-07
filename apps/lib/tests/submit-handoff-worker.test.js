/** Launch the real queued-submit process across the lib app's module graph [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../index.js';
import { HOOK_WORKER } from '../index.js';
import { submitHandoffWorkerEntrypoint } from '../index.js';
import { retryBusyHandoffWrite } from '../index.js';
import { submitUntilSettled } from '../src/shell/submit-infra-requeue.js';
import { Refused } from '../../../packages/kernel/index.js';
import { getItem } from '../../../packages/store/index.js';
import { submitHandoff } from '../../../packages/store/index.js';
import { writeBoardCommand } from '../../../packages/store/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { runFixtureChildAsync } from '../../../test/fixture-child.js';

/** Demand a genuine CLI success before reading its native document. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

test('queued handoff retries an injected busy board write and records the pinned write wait [C7]', async () => {
  let calls = 0;
  const waits = [];
  const board = { async write(candidate) {
    assert.equal(candidate, 'pinned-candidate');
    calls += 1;
    if (calls === 1) throw new Refused('BOARD_BUSY', 'fixture board is busy');
    return 'written';
  } };
  const out = await retryBusyHandoffWrite(() => board.write('pinned-candidate'), {
    wait: async ms => waits.push(ms), busyBudgetMs: 10_000,
  });
  assert.equal(out.result, 'written');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5_000]);
  assert.deepEqual(out.busyWaits, [{ code: 'BOARD_BUSY', seconds: 5 }]);
});

test('queued handoff retries an explicitly named locked database refusal [C7]', async () => {
  let calls = 0;
  const out = await retryBusyHandoffWrite(async () => {
    calls += 1;
    if (calls === 1) throw new Refused('DATABASE_LOCKED', 'fixture lock');
    return 'written';
  }, { wait: async () => {}, busyBudgetMs: 10_000 });
  assert.equal(out.result, 'written');
  assert.deepEqual(out.busyWaits, [{ code: 'DATABASE_LOCKED', seconds: 5 }]);
});

test('clause 3: queued handoff retries each busy storage code on the same pinned write and records every wait [C7]', async () => {
  const failures = [
    new Refused('BOARD_BUSY', 'fixture board is busy'),
    Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }),
    new Refused('SLOT_DB_LOCKED', 'fixture slot database is busy'),
  ];
  const candidates = [];
  const waits = [];
  const out = await retryBusyHandoffWrite(async () => {
    candidates.push('pinned-candidate');
    const failure = failures.shift();
    if (failure) throw failure;
    return 'written';
  }, { wait: async ms => waits.push(ms), busyBudgetMs: 60_000 });
  assert.equal(out.result, 'written');
  assert.deepEqual(candidates, Array(4).fill('pinned-candidate'));
  assert.deepEqual(waits, [5_000, 10_000, 20_000]);
  assert.deepEqual(out.busyWaits, [
    { code: 'BOARD_BUSY', seconds: 5 },
    { code: 'DATABASE_LOCKED', seconds: 10 },
    { code: 'SLOT_DB_LOCKED', seconds: 20 },
  ]);
});

test('clause 1: a queued submit stops waiting on a busy board at the lease end and then counts an infrastructure attempt [C7]', async () => {
  const waits = [];
  const run = async () => { throw new Refused('BOARD_BUSY', 'fixture board is busy'); };
  await assert.rejects(submitUntilSettled(run, { wait: async ms => waits.push(ms), healthy: async () => true, busyBudgetMs: 4_000, retries: 1, lockPauseMs: 1_000, lockMaxPauseMs: 2_000, pauseMs: 1 }),
    error => error.code === 'GATE_INFRA_EXHAUSTED' && error.attempts.length === 2);
  const busy = waits.slice(0, 3);
  assert.deepEqual(busy, [1_000, 2_000, 1_000], 'busy waits sum to exactly the lease budget');
  assert.equal(busy.reduce((sum, ms) => sum + ms, 0), 4_000);
});

test('clause 2: only runner or gate failures count toward GATE_INFRA_EXHAUSTED, busy codes never do [C7]', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls <= 3) throw new Refused(['BOARD_BUSY', 'DATABASE_LOCKED', 'SLOT_DB_LOCKED'][calls - 1], 'fixture storage is busy');
    return 'green';
  };
  const out = await submitUntilSettled(run, { wait: async () => {}, healthy: async () => true, retries: 1, lockPauseMs: 1 });
  assert.equal(out.result, 'green');
  assert.deepEqual(out.attempts, [], 'three busy stops counted no infrastructure attempt');
  let runnerCalls = 0;
  await assert.rejects(submitUntilSettled(async () => { runnerCalls += 1; throw new Refused('RUNNER_UNAVAILABLE', 'fixture runner is gone'); },
    { wait: async () => {}, healthy: async () => true, retries: 1 }), error => error.code === 'GATE_INFRA_EXHAUSTED' && runnerCalls === 2);
});

test('launched submit worker completes a native queued request without unsettled await [V4,H16,E18]', async t => {
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
  const id = document(box.run(box.repo, 'add', 'web', 'Real worker process', '--specs', 'G1',
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
  // budget: the existing owned-worker hang ceiling; assertions concern exit and native results, not elapsed time.
  const result = await runFixtureChildAsync(process.execPath, [submitHandoffWorkerEntrypoint(), request],
    { cwd: box.web, env: box.env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 13, result.context);
  assert.equal(result.status, 0, result.context);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
  assert.equal(submitHandoff(board, id).state, 'green');
  assert.equal(getItem(board, id).item_status, 'submitted');
  assert.equal(getItem(board, id).item_commit, commit);
  assert.equal(JSON.parse(readFileSync(join(directory, 'submission.json'), 'utf8')).commit, commit);
  assert.equal(existsSync(join(directory, 'source')), false, 'the launched supervisor removes its owned source');
});

test('resubmitting an orphaned queue without request or worker launches a fresh captured job [V4,H16,E18]', async t => {
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
  box.git(box.repo, 'commit', '-qm', 'test: orphaned queued worker fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const id = document(box.run(box.repo, 'add', 'web', 'Orphaned worker recovery', '--route', 'strong', '--specs', 'G1',
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
  assert.notEqual(current.id, orphan.id, 'the dead queue is closed before the same candidate gets a new identity');
  // The replacement's detached worker starts at once, so by the time this read runs the job may already be running or finished.
  assert.ok(['queued', 'running', 'green'].includes(current.state), `the replacement is a live job: ${current.state}`);
  const refusal = JSON.parse(readFileSync(join(orphanDirectory, 'refusal.json'), 'utf8'));
  assert.equal(refusal.error.code, 'SUBMIT_HANDOFF_NOT_LAUNCHED');
  assert.match(refusal.error.message, /request\.json and worker\.json are missing/u);
  const freshDirectory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', current.id);
  await helpers.waitFor(() => existsSync(join(freshDirectory, 'worker.json')), 'fresh detached worker owner record', 30000); // budget: owned worker launch ceiling, no timing claim.
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
  const id = document(box.run(box.repo, 'add', 'web', 'Hook process work',
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
