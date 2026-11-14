/** @pullboard-test-input source-tree */
/** @pullboard-world-pin: the save and cut cases read the shipped source to prove the old paths are gone. */
/** Durable wiring: production runs on the jobs and drive cells, and the old hand-off and landing paths are gone [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
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
} from '../../../../packages/jobs/index.js';
import {
  fixtureBoard,
  temporaryDirectory,
} from '../../tests/fixtures/board.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { openKitBoard } from '../../tests/fixtures/testkit.js';
import { readText } from '../../../../packages/gate/src/io/scan.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

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
