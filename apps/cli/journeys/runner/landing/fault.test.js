/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/landing/index.js packages/store/index.js */
/** A landing gate red only on runner refusals is a landing fault that retries, never a diagnosis or a park [C7,#3693]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import {
  runnerRefusalOnly,
  requireNoRunnerRefusalOnlyRed,
} from '../../../../../packages/landing/index.js';
import { repeatedBlockedCause } from '../../../../../packages/landing/index.js';
import { retryableLandingRefusal } from '../../../../../packages/landing/index.js';
import { landingFault } from '../../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** The shape of #2550's candidate-1.log (batch bc96678a): one shard refused twice, the rest green or stopped. */
const REFUSED_SHARDS = [
  '# landing shards: 2 balanced by history and average (1/2 1 files, 2/2 1 files)',
  'landing shard 2/2: runner fixture-a refused it: [SLOT_DB_LOCKED] never ran: the resource queue stayed locked for 10011ms; retry when the writer finishes',
  '# landing shard 2/2 attempt 1 on fixture-a: refused (runner refused: SLOT_DB_LOCKED) in 47 ms',
  'landing shard 2/2: runner fixture-a refused (runner refused: SLOT_DB_LOCKED); queuing shard 2/2 again (attempt 2)',
  '# landing shard 1/2 attempt 1 on fixture-b: green in 55 ms',
];
const STOPPED = [
  '# landing shard 2/2 attempt 2 on fixture-c: stopped in 44 ms',
  'run-tests: [SLOT_DB_LOCKED] never ran: the resource queue database stayed locked for 10015ms; retry when the writer finishes',
];

test('a gate log whose only non-green shards are runner refusals names their codes; any decided red names none [C7,#3693]', () => {
  const tap = ['TAP version 13', '# Subtest: kept', 'ok 1 - kept', '1..1', '# tests 1', '# pass 1', '# fail 0'];
  assert.deepEqual(runnerRefusalOnly([...REFUSED_SHARDS, ...tap, ...STOPPED].join('\n')), ['SLOT_DB_LOCKED']);
  assert.deepEqual(runnerRefusalOnly(['# landing shard 1/1 attempt 1 on h: infrastructure (runner transport lost) in 9 ms', ...tap].join('\n')), ['RUNNER_TRANSPORT_LOST']);
  const red = ['# Subtest: broken', 'not ok 2 - broken', '# fail 1'];
  assert.equal(runnerRefusalOnly([...REFUSED_SHARDS, ...red, ...STOPPED].join('\n')), null, 'a real failing case is never a fault');
  assert.equal(runnerRefusalOnly([...REFUSED_SHARDS, '# landing shard 1/2 attempt 1 on h: red in 9 ms'].join('\n')), null, 'a red shard decides');
  assert.equal(runnerRefusalOnly(['# landing shard 1/1 attempt 1 on local: refused (landing refused: LANDING_SOURCE_CHANGED) in 0 ms', 'run-tests: [SLOT_DB_LOCKED] never ran'].join('\n')), null, 'a changed source is not a runner fault');
  assert.equal(runnerRefusalOnly(tap.join('\n')), null, 'a red with no runner refusal stays a diagnosis');
  const log = [...REFUSED_SHARDS, ...tap, ...STOPPED].join('\n');
  assert.throws(() => requireNoRunnerRefusalOnlyRed({ isGreen: false, failures: [], logPath: 'x.log' }, () => log),
    error => error.code === 'LAND_RUNNER_FAULT' && landingFault(error) && retryableLandingRefusal(error.code));
  assert.doesNotThrow(() => requireNoRunnerRefusalOnlyRed({ isGreen: false, failures: [{ file: 'a.test.js', name: 'n' }], logPath: 'x.log' }, () => log));
  assert.doesNotThrow(() => requireNoRunnerRefusalOnlyRed({ isGreen: false, timedOut: true, failures: [], logPath: 'x.log' }, () => log));
});

test('the repeat guard never parks on a landing fault and still parks on a repeated diagnosis [C7,#3693]', () => {
  const item = { item_id: 7, item_commit: 'c'.repeat(40) };
  const batch = (id, code) => ({ id, state: 'blocked', base: 'b'.repeat(40), items: [{ id: 7, commit: item.item_commit }], refusal: { code, message: code } });
  for (const code of ['LAND_RUNNER_FAULT', 'SLOT_DB_LOCKED', 'BOARD_BUSY']) assert.equal(repeatedBlockedCause([batch('a', code), batch('b', code)], item), null, code);
  assert.equal(repeatedBlockedCause([batch('a', 'LAND_DIAGNOSTIC'), batch('b', 'LAND_DIAGNOSTIC')], item)?.key, 'LAND_DIAGNOSTIC');
});

/** A separate-publish landing project whose fixture gate prints #2550's runner refusals while LAND_RUNNER_REFUSAL is set. */
function refusingProject() {
  const box = landProject({ withWorktree: false });
  const path = join(box.repo, 'pullboard.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  const gate = join(box.dir, 'land-gate.cjs');
  const refusing = "process.env.LAND_RUNNER_REFUSAL === '1' && !alone";
  const source = readFileSync(gate, 'utf8')
    .replace("console.log('TAP version 13'); let failed = 0;",
      `if (${refusing}) console.log(${JSON.stringify(REFUSED_SHARDS.join('\n'))}); console.log('TAP version 13'); let failed = 0;`)
    .replace('process.exitCode = failed || cancelled ? 1 : 0;',
      `process.exitCode = failed || cancelled ? 1 : 0; if (${refusing}) { console.log(${JSON.stringify(STOPPED.join('\n'))}); process.exitCode = 1; }`);
  assert.notEqual(source, readFileSync(gate, 'utf8'));
  writeFileSync(gate, source);
  return box;
}

/** Submit and accept one item with its red suppressed, then move main so the landing runs its own gate. */
function acceptedItem(box, number, contents) {
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    const entry = itemWorktree(box, number);
    submitItem(box, entry, contents);
    acceptItem(box, entry);
    const moved = commitFile(box, box.repo, `web/main-moved-${number}.txt`, 'main moved\n', `chore(web): main moves past the submit ${number} [G1]`);
    assert.equal(moved.status, 0, moved.stderr);
    return entry;
  } finally { delete box.env.LAND_SUPPRESS_RED; }
}

/** Run one real landing batch on the fixture board and return its record, the landing's lines and the item. */
function landBatch(box, itemId) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/config/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, itemId] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (failure) { error = failure.code ?? String(failure); }',
    'const batch = store.landingBatches(board).at(-1); const item = store.getItem(board, Number(itemId));',
    'console.log(JSON.stringify({ error, lines, batch, merged: item.item_merged_commit, status: item.item_status, held: item.item_hold_at ?? null }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('clause 1: a real landing gate red only on runner refusals is retried as a landing fault, never LAND_DIAGNOSTIC and never parked [C7,#3693]', { timeout: 300_000 }, // budget: one real submit and accept, three real landings; hang ceiling only.
() => {
  const box = refusingProject();
  const entry = acceptedItem(box, 1, 'PASS\n');
  box.env.LAND_RUNNER_REFUSAL = '1';
  const batches = new Set();
  for (const round of [1, 2]) {
    const result = landBatch(box, entry.item);
    const why = JSON.stringify({ round, error: result.error, refusal: result.batch?.refusal, lines: result.lines });
    assert.equal(result.error, 'LAND_RUNNER_FAULT', why);
    assert.equal(result.batch.refusal?.code, 'LAND_RUNNER_FAULT', why);
    assert.match(result.batch.refusal.message, /only runner refusals stopped it \(SLOT_DB_LOCKED\)/u, why);
    assert.ok(!(result.batch.refusals ?? []).some(row => row.code === 'LAND_DIAGNOSTIC'), why);
    assert.deepEqual(result.batch.culprits ?? [], [], 'no item is charged');
    assert.equal(result.status, 'verified', 'the item stays accepted');
    assert.equal(result.held, null, `round ${round}: a landing fault never counts toward parking`);
    assert.ok(!result.merged, 'nothing lands on a fault');
    batches.add(result.batch.id);
  }
  assert.equal(batches.size, 2, 'each retry is its own batch, as #2550 had two');
  delete box.env.LAND_RUNNER_REFUSAL;
  const retried = landBatch(box, entry.item);
  assert.equal(retried.error, null, JSON.stringify(retried.lines));
  assert.ok(retried.merged, 'once the runners answer, the retried item lands');
});

test('clause 2: a real landing gate with a failing case beside runner refusals still diagnoses the case [C7,#3693]', { timeout: 300_000 }, // budget: one real submit and accept, one real landing; hang ceiling only.
() => {
  const box = refusingProject();
  const entry = acceptedItem(box, 1, '// RED NAME:batch-red-case\n');
  box.env.LAND_RUNNER_REFUSAL = '1';
  const result = landBatch(box, entry.item);
  const why = JSON.stringify({ error: result.error, batch: result.batch, lines: result.lines });
  assert.notEqual(result.error, 'LAND_RUNNER_FAULT', why);
  assert.notEqual(result.batch.refusal?.code, 'LAND_RUNNER_FAULT', why);
  assert.ok(!result.merged, 'the red item stays off main');
  assert.ok((result.batch.culprits ?? []).some(culprit => culprit.id === entry.item
    && culprit.tests.some(row => row.file === entry.file && row.name === 'batch-red-case')), why);
  assert.equal(result.status, 'open', 'the item goes back with its failing case');
});
