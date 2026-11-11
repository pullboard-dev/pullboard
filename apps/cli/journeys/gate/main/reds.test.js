/** Conveyor 1: a gate passes an item whose only reds are already red on main, using fresh main receipts [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import {
  handoffRecord,
  openBoardReadOnly,
} from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { dispatcherPass } from '../../../../lib/src/io/handoff/dispatcher.js';
import * as jobs from '../../../../../packages/jobs/index.js';
import {
  mainRedLookup,
  MAIN_TEST_JOB,
} from '../../../../../packages/drive/index.js';
import {
  recordGateVerdict,
  finishAwaitingVerdicts,
  returnMainTest,
  gateVerdictJobId,
  GATE_VERDICT_KIND,
} from '../../../../../packages/gate/index.js';


/** Hand the body a production-schema board in memory, closed when the case ends. */
function withBoard(t, body) {
  return body(fixtureBoard(t).db);
}

/** The ports a production caller passes: the jobs cell and the drive cell's main-test enqueue. */
const ports = { jobs, mainTestKind: MAIN_TEST_JOB, queueMainTest: (db, at) => mainRedLookup(db, [], at).job };

const base = { commit: 'c'.repeat(40), tree: 't'.repeat(40), at: 10_000 };
const command = 'npm test --';
const file = 'test/a.test.js';
const reds = [{ file, name: 'case one' }, { file, name: 'case two' }];

/** A main receipt for the red file at the gate base's tree. */
function receipt(fields = {}) {
  return { id: 'mr-1', tree: base.tree, file, command, verdict: 'red', failing: ['case one', 'case two', 'case three'], at: base.at + 5, ...fields };
}

/** Rows the board holds for builder facts and events: a gate that never bounces writes none. */
function builderRows(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
}

test('clause 1: every red named red by a fresh main receipt at the gate base records green with those cases listed as main-owned, no fact or resubmit [C7]', t => {
  withBoard(t, (db) => {
    const gate = recordGateVerdict(ports, db, { item: 7, candidate: 'a'.repeat(40), base, command, reds, receipts: [receipt()], now: 20_000 });
    assert.equal(gate.verdict, 'green');
    assert.deepEqual(gate.queued, [], 'a fresh receipt queues no main-test job');
    const job = jobs.jobView(db, gateVerdictJobId(7, 'a'.repeat(40)));
    assert.equal(job.kind, GATE_VERDICT_KIND);
    assert.deepEqual(job.steps.map(step => step.name), ['verdict'], 'the gate records its verdict once and never waits or bounces');
    assert.deepEqual(job.steps[0].payload, { green: true, receipts: ['mr-1'],
      mainOwned: [{ file, name: 'case one', receipt: 'mr-1' }, { file, name: 'case two', receipt: 'mr-1' }] }, 'green with the main-owned cases and their receipt');
    assert.equal(jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).length, 0);
    assert.equal(builderRows(db), 0, 'no builder fact or event is written: nothing asks for a resubmit');

    const stale = recordGateVerdict(ports, db, { item: 8, candidate: 'b'.repeat(40), base, command, reds, receipts: [receipt({ at: base.at - 1 })], now: 20_000 });
    assert.notEqual(stale.verdict, 'green', 'a receipt older than the base never excuses a red');
    const other = recordGateVerdict(ports, db, { item: 9, candidate: 'd'.repeat(40), base, command, reds, receipts: [receipt({ tree: 'e'.repeat(40) })], now: 20_000 });
    assert.notEqual(other.verdict, 'green', 'a receipt at another main tree never excuses a red');
    const own = recordGateVerdict(ports, db, { item: 10, candidate: 'f'.repeat(40), base, command, reds: [...reds, { file, name: 'case new' }], receipts: [receipt()], now: 20_000 });
    assert.equal(own.verdict, 'red', 'a case main does not name is the candidate\'s own');
    assert.deepEqual(own.own, [{ file, name: 'case new' }]);
    assert.equal(jobs.jobView(db, own.id).steps[0].payload.green, false);
  });
});

test('clause 2: a red file with no fresh main receipt queues a main-test job and the verdict finishes when it returns, without bouncing [C7]', t => {
  withBoard(t, (db) => {
    const candidate = 'a'.repeat(40);
    const gate = recordGateVerdict(ports, db, { item: 7, candidate, base, command, reds, receipts: [receipt({ at: base.at - 1 })], now: 20_000 });
    assert.equal(gate.verdict, 'pending', 'no fresh receipt: the verdict waits, it is not red');
    assert.deepEqual(gate.missing, [file]);
    assert.equal(gate.queued.length, 1);
    const mainTest = jobs.jobView(db, gate.queued[0]);
    assert.equal(mainTest.kind, MAIN_TEST_JOB);
    assert.equal(mainTest.step, 'queued', 'the main-test job waits for a driver');
    assert.deepEqual(mainTest.steps[0].payload, { tree: base.tree, file, command });
    assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main');
    assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 21_000 }), [], 'nothing finishes before the main-test job returns');
    assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main');

    const again = recordGateVerdict(ports, db, { item: 7, candidate, base, command, reds, now: 21_500 });
    assert.deepEqual(again.queued, gate.queued, 'a second judge of the same gate reuses the one main-test job');
    assert.equal(jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).length, 1);

    returnMainTest(jobs, db, gate.queued[0], receipt({ id: 'mr-2', at: 22_000 }), { now: 22_000 });
    const finished = finishAwaitingVerdicts(ports, db, { now: 23_000 });
    assert.deepEqual(finished.map(row => ({ id: row.id, verdict: row.verdict })), [{ id: gate.id, verdict: 'green' }]);
    const job = jobs.jobView(db, gate.id);
    assert.deepEqual(job.steps.map(step => step.name), ['awaiting-main', 'verdict'], 'waited on main, then recorded the verdict: no bounce step');
    assert.deepEqual(job.steps[1].payload.mainOwned, [{ file, name: 'case one', receipt: 'mr-2' }, { file, name: 'case two', receipt: 'mr-2' }]);
    assert.equal(job.steps[1].payload.green, true);
    assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 24_000 }), [], 'a finished verdict is not judged twice');
    assert.equal(builderRows(db), 0, 'the builder got no fact and no bounce');

    const greenMain = recordGateVerdict(ports, db, { item: 11, candidate: 'b'.repeat(40), base, command, reds: [{ file: 'test/b.test.js', name: 'case b' }], now: 25_000 });
    assert.equal(greenMain.verdict, 'pending');
    returnMainTest(jobs, db, greenMain.queued[0], { id: 'mr-3', tree: base.tree, file: 'test/b.test.js', command, verdict: 'green', failing: [], at: 26_000 }, { now: 26_000 });
    assert.deepEqual(finishAwaitingVerdicts(ports, db, { now: 27_000 }).map(row => ({ verdict: row.verdict, own: row.own })),
      [{ verdict: 'red', own: [{ file: 'test/b.test.js', name: 'case b' }] }], 'main green on the file: the returned verdict is the candidate\'s red');
  });
});

/** A real repository whose main already fails one named case, with an item whose frozen check runs that file, queued submits on. */
function queuedMainRedProject(helpers) {
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.submit = { ...config.submit, handoff: true };
  config.affectedTests = 'node web/runner.js';
  writeFileSync(configFile, JSON.stringify(config));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/runner.js'), [
    "import { spawnSync } from 'node:child_process';",
    'const files = process.argv.slice(2);',
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  writeFileSync(join(box.repo, 'web/package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/main-red.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('main red case [G1]', () => assert.equal(1, 2));\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: main with one red case');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Change beside a main red', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The change lands beside main\'s own red.', '--brief', 'Files:\n- web/snapshot.txt\nTest:\n- web/main-red.test.js\n',
    '--check', 'node web/runner.js web/main-red.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  return { box, id: JSON.parse(added.out).item.item_id };
}

/** The queued submit's job, the item and the board's gate verdict and main-test jobs, read from the real board file read-only. */
function queuedRecord(box, id) {
  const db = openBoardReadOnly(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    return { job: handoffRecord(db, id) ?? null, item: db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(id),
      verdicts: jobs.jobsOf(db, { kind: GATE_VERDICT_KIND, item: id }), mainTests: jobs.jobsOf(db, { kind: MAIN_TEST_JOB }) };
  } finally { db.close(); }
}

/** Claim the item, commit a change, and submit through the real queued worker; returns the terminal record. */
async function submitQueued(helpers, box, id, { moveMain = false } = {}) {
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const source = JSON.parse(claimed.out).itemFolder ?? box.web;
  const committed = helpers.commitFile(box, source, 'web/snapshot.txt', 'candidate\n', 'feat(web): change beside a main red [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  if (moveMain) {
    // Main moves after the claim, so main has no receipt at the gate's new base until a main-test job writes one.
    writeFileSync(join(box.repo, 'docs-note.txt'), 'main moved\n');
    box.git(box.repo, 'add', 'docs-note.txt');
    box.git(box.repo, 'commit', '-qm', 'docs: main moves after the claim');
  }
  const submitted = box.run(source, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  assert.equal(JSON.parse(submitted.out).queued, true, 'the submit is queued for the real worker');
  await helpers.waitFor(() => ['green', 'infrastructure', 'red', 'incomplete'].includes(queuedRecord(box, id).job?.state), // budget: real queued worker hang ceiling
    'queued worker terminal result', 100_000); // budget: hang ceiling for one real queued gate; no elapsed-time assertion
  return queuedRecord(box, id);
}

/**
 * The thread's facts about main's red: the known-main measurement a red gate made the builder carry. The machine's own
 * bookkeeping facts (the tier-1 shadow, the automatic main merge, the review comparison) do not name the red.
 */
function facts(box, id) {
  const shown = box.run(box.repo, 'show', String(id), '--json');
  return JSON.parse(shown.out).thread.filter(entry => entry.type === 'fact' && /main-red\.test\.js|main red|known main/iu.test(entry.text))
    .map(entry => entry.text);
}

/** Remove the fixtures without blocking the main thread once the owned worker has let go. */
async function cleanupQueued(helpers, box) {
  try {
    const jobsDir = join(box.repo, '.git/pullboard/submit-handoffs');
    const idle = () => !existsSync(jobsDir) || readdirSync(jobsDir).every(job => !existsSync(join(jobsDir, job, 'source')));
    await helpers.waitFor(idle, 'owned worker cleanup', 20_000); // budget: hang ceiling inside the runner's 30 s file-exit window; no elapsed-time assertion
  } catch { /* A worker still running past the ceiling is removed with its fixture below. */ }
  await Promise.all(helpers.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
}

test('clause 1: a real queued submit whose frozen check is red only in main\'s own case records a green gate listing it main-owned, with no builder fact [C7]', { timeout: 150_000 }, async t => {
  const helpers = createE2eHelpers();
  const { box, id } = queuedMainRedProject(helpers);
  t.after(() => cleanupQueued(helpers, box));
  const record = await submitQueued(helpers, box, id);
  assert.equal(record.job.state, 'green', JSON.stringify(record.job));
  assert.equal(record.item.item_status, 'submitted', 'the item is submitted: nothing bounced it to the builder');
  const verdict = record.verdicts.at(-1).steps.find(step => step.name === 'verdict').payload;
  assert.equal(verdict.green, true, 'the gate records green');
  assert.deepEqual(verdict.mainOwned.map(({ file, name }) => ({ file, name })), [{ file: 'web/main-red.test.js', name: 'main red case [G1]' }], 'the red case is listed as main-owned');
  assert.deepEqual(facts(box, id), [], 'no fact about main\'s red is written for the builder');
});

test('clause 2: a real queued submit with no main receipt at its base runs the main-test job and finishes green when it returns, without a bounce [C7]', { timeout: 150_000 }, async t => {
  const helpers = createE2eHelpers();
  const { box, id } = queuedMainRedProject(helpers);
  t.after(() => cleanupQueued(helpers, box));
  const record = await submitQueued(helpers, box, id, { moveMain: true });
  assert.equal(record.job.state, 'green', JSON.stringify(record.job));
  assert.equal(record.item.item_status, 'submitted', 'the item is submitted: nothing bounced it to the builder');
  const steps = record.verdicts.at(-1).steps.map(step => step.name);
  assert.deepEqual(steps, ['awaiting-main', 'verdict'], 'the verdict waited on main, then finished');
  const returned = record.mainTests.filter(job => job.steps.some(step => step.name === 'receipt'));
  assert.ok(returned.some(job => job.steps.find(step => step.name === 'receipt').payload.file === 'web/main-red.test.js'), 'the main-test job returned its receipt');
  assert.equal(record.verdicts.at(-1).steps.at(-1).payload.green, true);
  assert.deepEqual(facts(box, id), [], 'no fact about main\'s red is written for the builder');
});

test('clause 2: the dispatcher pass finishes a verdict waiting on main once its main-test job returned, at most every 5 s [C7]', t => {
  withBoard(t, (db) => {
    const gate = recordGateVerdict(ports, db, { item: 21, candidate: 'a'.repeat(40), base, command, reds, now: 30_000 });
    assert.equal(gate.verdict, 'pending');
    let clock = 100_000, renewed = 0;
    const pass = dispatcherPass({ renew: () => { renewed += 1; }, withDb: work => work(db) }, { now: () => clock });
    pass();
    assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main', 'nothing to finish before the main-test job returns');
    returnMainTest(jobs, db, gate.queued[0], receipt({ id: 'mr-d', at: 31_000 }), { now: 31_000 });
    clock += 1_000;
    pass();
    assert.equal(jobs.jobView(db, gate.id).step, 'awaiting-main', 'the pass looks at most every 5 s');
    clock += 5_000;
    pass();
    assert.equal(jobs.jobView(db, gate.id).step, 'verdict', 'the drive loop finished the waiting verdict');
    assert.equal(jobs.jobView(db, gate.id).steps.at(-1).payload.green, true);
    assert.equal(renewed, 3, 'every pass still renews the dispatcher row');
  });
});
