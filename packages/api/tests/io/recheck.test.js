/** @pullboard-test-input packages/api/tests/fixtures/recheck-admission-retained.json */
/** A main-test job names the cases a red file fails on main, and a red it cannot read keys no receipt [C7,P7]. */
/** @pullboard-world-pin: clause 1 replays immutable retained native proof data through MAIN_TEST_ENTRY, including its original input key. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { classifyGateRed } from '../../../drive/index.js';
import { mainRedLookup } from '../../../drive/index.js';
import { MAIN_TEST_JOB } from '../../../drive/index.js';
import * as jobs from '../../../jobs/index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { applyMainTestReceipt } from '../../src/io/recheck.js';
import { budgetCase } from '../../src/io/recheck.js';
import { compareGateWithMain } from '../../src/io/gate.js';
import { seedWideMainTests } from '../../src/io/recheck.js';
import { boardJobQueueCall } from '../../src/io/gate.js';
import { MAIN_TEST_ENTRY } from '../../src/io/recheck.js';
import { MAIN_CASE_NAME_UNITS } from '../../src/io/recheck.js';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const id = '12345678-1234-1234-1234-123456789abc';
const file = 'tests/red.test.js';
const command = 'node --test';
const tap = `TAP version 13\nnot ok 1 - main fails\n  ---\n  location: '${root}/${file}:3:1'\n  ...\nok 2 - main passes\n1..2\n# tests 2\n# pass 1\n# fail 1\n`;
const rows = [{ file, name: 'main fails', passed: false, skipped: false, failure: 'assertion' }, { file, name: 'main passes', passed: true, skipped: false }];

/** The native outcome frames a run prints, one per test row, as the controller writes them (an api test cannot import the gate cell that owns the writer). */
function formatTestOutcomes(runId, tests) {
  return tests.map(row => '# pullboard test outcomes ' + JSON.stringify({ version: 1, id: runId, tests: [row] }) + '\n').join('');
}

/** The keyed receipt steps the board holds for main-test jobs: what a gate reads back. */
function returnedMainReceipts(db) {
  return jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).flatMap(job => job.steps.filter(step => step.name === 'receipt' && typeof step.payload?.tree === 'string').map(step => step.payload));
}

let loads = 0;

/**
 * Run the job's entry in this process against a command that prints `output` and exits 1; return its verdict line,
 * parsed. Why in-process: the entry only reads argv, cwd and stdout, so a test swaps those and restores them, with no
 * node child of its own; the entry still runs its fixture command itself, as a runner would.
 */
async function entryVerdict(output, { stderr = '', status = 1 } = {}) {
  const encoded = Buffer.from(output).toString('base64');
  const diagnostic = Buffer.from(stderr).toString('base64');
  const emit = `node -e "process.stdout.write(Buffer.from('${encoded}', 'base64')); process.stderr.write(Buffer.from('${diagnostic}', 'base64')); process.exitCode = ${status}"`;
  const saved = { argv: process.argv, write: process.stdout.write, exitCode: process.exitCode, directory: process.cwd(), context: process.env.NODE_TEST_CONTEXT };
  let tail = '';
  delete process.env.NODE_TEST_CONTEXT;
  process.argv = [process.argv[0], emit, file];
  process.stdout.write = text => { tail += String(text); return true; };
  try {
    process.chdir(root);
    await import(`data:text/javascript;base64,${Buffer.from(`${MAIN_TEST_ENTRY}\n// run ${loads++}`).toString('base64')}`);
  } finally {
    process.stdout.write = saved.write;
    process.argv = saved.argv;
    process.exitCode = saved.exitCode;
    process.chdir(saved.directory);
    if (saved.context !== undefined) process.env.NODE_TEST_CONTEXT = saved.context;
  }
  const line = tail.split('\n').findLast(row => row.startsWith('PULLBOARD_MAIN_TEST '));
  return { line, verdict: JSON.parse(line.slice('PULLBOARD_MAIN_TEST '.length)), tail };
}

/** The immutable native admission transcript; replay relocates only its recorded execution root into this fixture. */
function admissionStreams() {
  const retained = JSON.parse(readFileSync(new URL('../fixtures/recheck-admission-retained.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(retained.text).digest('hex'), retained.sha256);
  const source = retained.text.split(retained.executionRoot).join(root);
  const cache = source.split('\n').find(line => line.startsWith('# pullboard test cache '));
  const inputKey = JSON.parse(cache.slice('# pullboard test cache '.length)).inputKey;
  const cpu = 'CPU-load test uses the current admitted slot because no runners are registered';
  const stderr = source.split('\n').filter(line => line === cpu || line.startsWith('(node:')
    || line.startsWith('(Use `node --trace-warnings') || line.startsWith('run-tests: phases '));
  // Main predates the candidate-only failure-frame producer. Remove that one metadata line for this historical-reader fixture;
  // never edit the retained bytes or infer per-case outcomes from its nested parent errors.
  let stdout = source.split('\n').filter(line => !stderr.includes(line) && !line.startsWith('# pullboard file failures ')).join('\n');
  stdout = stdout.split('packages/gate/tests/io/main/admission-loans-p95-native.test.js').join(file);
  return { stdout, stderr: stderr.join('\n') + '\n', cpu, inputKey };
}

const admissionNames = ['p95 stays below twice standalone', 'native',
  'gate.io-main-admission-loans-p95-native.four-concurrent-runs-start-only-token: four concurrent runs start only token-owned file processes and keep p95 below twice standalone [C7]']
  .map(name => name.slice(0, MAIN_CASE_NAME_UNITS));

test('api.recheck.cpu-admission-nested-stderr: clause 1: the exact native CPU diagnostic on stderr preserves nested named failures, signatures and input key through receipt application [C7,P7]', async t => {
  const streams = admissionStreams();
  const plain = await entryVerdict(streams.stdout);
  assert.deepEqual(plain.verdict.failing, admissionNames, 'nested counts and names are sufficient without guessing leaves');
  const measured = await entryVerdict(streams.stdout, { stderr: streams.stderr });
  assert.equal(measured.verdict.green, false);
  assert.equal(measured.verdict.status, 1);
  assert.deepEqual(measured.verdict.failing, admissionNames);
  assert.deepEqual(measured.verdict.signatures, plain.verdict.signatures, 'reporting projection preserves every diagnostic signature');
  assert.ok(measured.verdict.signatures.every(signature => /^[a-f0-9]{64}$/u.test(signature)));
  assert.equal(measured.verdict.inputKey, streams.inputKey);
  assert.ok(measured.tail.includes(streams.cpu), 'original stderr is retained in the receipt output');
  const { board, job } = queued(t, 'e'.repeat(40));
  assert.equal(applyMainTestReceipt(board, { job, receipt: { tail: measured.tail, commit: 'c'.repeat(40) } }).outcome, 'recorded');
  const [receipt] = returnedMainReceipts(board.db);
  assert.deepEqual(receipt.failing, admissionNames);
  assert.deepEqual(receipt.signatures, measured.verdict.signatures);
  assert.equal(receipt.inputKey, measured.verdict.inputKey);
  assert.equal(receipt.verdict, 'red');
});

test('api.recheck.cpu-admission-negative-controls: clause 2: unknown stderr, unbound or malformed frames, torn TAP and ambiguous file or name identity still record no receipt [C7,P7]', async t => {
  const streams = admissionStreams();
  const timing = streams.stdout.split('\n').find(line => line.startsWith('# pullboard suite timing '));
  const bound = JSON.parse(timing.slice('# pullboard suite timing '.length));
  const cases = [
    ['unknown stderr', streams.stdout, streams.stderr + 'unexpected command failure\n'],
    ['altered CPU diagnostic', streams.stdout, streams.stderr.replace(streams.cpu, streams.cpu + ' altered')],
    ['duplicate CPU diagnostic', streams.stdout, streams.stderr + streams.cpu + '\n'],
    ['diagnostic on stdout', streams.stdout + streams.cpu + '\n', streams.stderr.replace(streams.cpu + '\n', '')],
    ['unbound result', streams.stdout.replace(timing, ''), streams.stderr],
    ['foreign outcome invocation', streams.stdout + formatTestOutcomes(id, rows), streams.stderr],
    ['malformed source binding', streams.stdout.replace(timing, timing.replace(bound.head, 'invalid')), streams.stderr],
    ['duplicate timing', streams.stdout + timing + '\n', streams.stderr],
    ['torn TAP count', streams.stdout.replace('# fail 3\n', ''), streams.stderr],
    ['cancellation', streams.stdout.replace('# cancelled 0', '# cancelled 1'), streams.stderr],
    ['foreign file', streams.stdout.split(`${root}/${file}`).join(`/outside/${file}`), streams.stderr],
    ['duplicate nested identity', streams.stdout.replace('not ok 1 - native\n', 'not ok 1 - p95 stays below twice standalone\n'), streams.stderr],
    ['ambiguous bounded identity', streams.stdout.replace('not ok 1 - native\n', `not ok 1 - ${admissionNames[2]} distinct suffix\n`), streams.stderr],
  ];
  for (const [name, output, diagnostic] of cases) {
    const measured = await entryVerdict(output, { stderr: diagnostic });
    assert.equal(measured.verdict.failing, null, name);
    const { board, job } = queued(t, 'f'.repeat(40));
    const applied = applyMainTestReceipt(board, { job, receipt: { tail: measured.tail, commit: 'c'.repeat(40) } });
    assert.deepEqual(applied, { applied: false, outcome: 'unnamed' }, name);
    assert.deepEqual(returnedMainReceipts(board.db), [], name);
  }
});

test('api.recheck.cpu-admission-changed-signature: clause 2: a different real nested assertion remains red with its actual name and different signature [C7,P7]', async () => {
  const streams = admissionStreams();
  const before = await entryVerdict(streams.stdout, { stderr: streams.stderr });
  const after = await entryVerdict(streams.stdout.replace('ratio 2.7039173785898596', 'ratio 7.125'), { stderr: streams.stderr });
  assert.deepEqual(before.verdict.failing, admissionNames);
  assert.deepEqual(after.verdict.failing, admissionNames);
  assert.notEqual(after.verdict.signatures[0], before.verdict.signatures[0]);
  assert.equal(after.verdict.green, false);
});

test('api.recheck.cpu-admission-success-preserved: clause 2: ordinary successful execution retains its status and original diagnostic output [C7,P7]', async () => {
  const streams = admissionStreams();
  const { verdict, tail } = await entryVerdict('ordinary successful command\n', { status: 0, stderr: streams.cpu + '\n' });
  assert.equal(verdict.green, true);
  assert.equal(verdict.status, 0);
  assert.deepEqual(verdict.failing, []);
  assert.deepEqual(verdict.signatures, []);
  assert.ok(tail.includes('ordinary successful command'));
  assert.ok(tail.includes(streams.cpu));
});

/** A queued main-test job on a fresh in-memory board, and the board. */
function queued(t, tree) {
  const { db } = fixtureBoard(t);
  const job = mainRedLookup(db, [], { tree, file, command, now: 1000 }).job;
  return { board: { db, gitRoot: null }, job };
}

test('api.recheck.red-file-whose-run-printed: clause 1: a red file whose run printed native outcome frames is named by its failing cases in the receipt line [C7,P7]', async () => {
  const { verdict } = await entryVerdict(tap + formatTestOutcomes(id, rows));
  assert.equal(verdict.green, false);
  assert.deepEqual(verdict.failing, ['main fails']);
  assert.equal(verdict.signatures.length, 1);
});

test('api.recheck.red-whose-cases-cannot-read: clause 2: a red whose cases cannot be read records no receipt, so a gate never reads it as naming none [C7,P7]', async t => {
  const frames = formatTestOutcomes(id, rows).replace('"version":1', '"version":2');
  const { verdict, tail } = await entryVerdict(tap + frames);
  assert.equal(verdict.failing, null, 'unreadable cases are null, never an empty list');
  const { board, job } = queued(t, 'e'.repeat(40));
  const result = applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  assert.deepEqual({ applied: result.applied, outcome: result.outcome }, { applied: false, outcome: 'unnamed' });
  assert.deepEqual(returnedMainReceipts(board.db), []);
});

test('api.recheck.gate-red-only-case-main: clause 3: a gate red only on a case main also fails has its receipt recorded naming that case [C7,P7]', async t => {
  const tree = 'e'.repeat(40);
  const { tail } = await entryVerdict(tap + formatTestOutcomes(id, rows));
  const { board, job } = queued(t, tree);
  const result = applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  assert.equal(result.verdict, 'red');
  const receipts = returnedMainReceipts(board.db);
  assert.deepEqual(receipts[0].failing, ['main fails']);
  assert.deepEqual({ tree: receipts[0].tree, file: receipts[0].file, command: receipts[0].command, verdict: receipts[0].verdict, main: receipts[0].main }, { tree, file, command, verdict: 'red', main: 'c'.repeat(40) }, 'the receipt keys the tree, file and command a gate looks up');
});

test('api.recheck.red-run-prints-suite-timing: clause 1: a red run that prints a suite timing frame and the phase line after the TAP summary still names its failing cases [C7,P7]', async () => {
  const frame = '# pullboard suite timing ' + JSON.stringify({ version: 1, id, head: 'a'.repeat(40), tree: 'b'.repeat(40), full: false, node: '22.13.1', wallMs: 1200, selectionMs: 10, setupMs: 20, shards: null, compareMs: 5 }) + '\n';
  const output = tap + formatTestOutcomes(id, rows) + frame + 'run-tests: phases select 0.1s, total 1.2s\n';
  const { verdict } = await entryVerdict(output);
  assert.equal(verdict.green, false);
  assert.deepEqual(verdict.failing, ['main fails']);
  assert.equal(verdict.signatures.length, 1);
});

test('api.recheck.main-test-receipt-from-run: clause 2: a main-test receipt from a run with the timing frame is keyed and names its case, so a gate red on only that case reads main-owned [C7,P7]', async t => {
  const tree = 'e'.repeat(40);
  const frame = '# pullboard suite timing ' + JSON.stringify({ version: 1, id, head: 'a'.repeat(40), tree: 'b'.repeat(40), full: false, node: '22.13.1', wallMs: 1200, selectionMs: 10, setupMs: 20, shards: null, compareMs: 5 }) + '\n';
  const { tail } = await entryVerdict(tap + formatTestOutcomes(id, rows) + frame);
  const { board, job } = queued(t, tree);
  const result = applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  assert.equal(result.verdict, 'red');
  assert.deepEqual(returnedMainReceipts(board.db).map(receipt => receipt.failing), [['main fails']]);
  const verdict = classifyGateRed(board.db, returnedMainReceipts(board.db), { tree, file, command, reds: ['main fails'], now: 3000 });
  assert.equal(verdict.job, null, 'a recorded receipt queues no further job');
  assert.deepEqual({ owner: verdict.owner, code: verdict.code }, { owner: 'main', code: 'MAIN_OWN_RED' });
});

test('api.recheck.red-whose-cases-truly-cannot: clause 3: a red whose cases truly cannot be read, timing frame or not, still records no receipt [C7,P7]', async t => {
  const frame = '# pullboard suite timing ' + JSON.stringify({ version: 1, id, head: 'a'.repeat(40), tree: 'b'.repeat(40), full: false, node: '22.13.1', wallMs: 1, selectionMs: 1, setupMs: 1, shards: null, compareMs: 1 }) + '\n';
  const unreadable = formatTestOutcomes(id, rows).replace('"version":1', '"version":2');
  const { verdict, tail } = await entryVerdict(tap + unreadable + frame);
  assert.equal(verdict.failing, null);
  const { board, job } = queued(t, 'f'.repeat(40));
  assert.equal(applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 }).applied, false);
  assert.deepEqual(returnedMainReceipts(board.db), []);
});

/** One finished gate shard of `item` whose receipt names `files` as failed, as a pulled gate records it. */
function redShard(db, item, files, now) {
  const job = `gate:${item}:fixture:shard:${files[0]}`;
  jobs.createJob(db, { id: job, kind: 'gate-shard', item, now });
  jobs.writeStep(db, job, 'receipt', { runner: 'r', attempt: 1, receipt: { status: 1, gate: { phases: [{ role: 'proof', status: 1, failures: files.map(name => ({ file: name, name: 'case' })) }] } } }, { seq: 1, now });
}

/** A board whose queue holds red shards of `wide` and `narrow` files, and the repository's accepted main and tree. */
function wideBoard(t) {
  const project = cellProject(t, { real: true, config: { affectedTests: 'node --test' } });
  const { db } = fixtureBoard(t);
  const now = 10 * 3_600_000;
  for (let item = 1; item <= 12; item++) redShard(db, item, ['tests/wide.test.js', 'tests/answered.test.js'], now - 1000);
  for (let item = 1; item <= 9; item++) redShard(db, 100 + item, ['tests/narrow.test.js'], now - 1000);
  for (let item = 1; item <= 12; item++) redShard(db, 200 + item, ['tests/old.test.js'], now - 25 * 3_600_000);
  return { project, db, now, main: project.git(project.repo, 'rev-parse', 'HEAD'), tree: project.git(project.repo, 'rev-parse', 'HEAD^{tree}') };
}

/** Another open of the same board root: its own db handle, the same repository. */
function reopened(t, project) {
  return { db: fixtureBoard(t).db, gitRoot: project.repo };
}

test('api.io-recheck.seed-once-per-main: clause 1: with gate.seedWideMainTests on, seedWideMainTests queues one main-test row per file red in the gates of 10 or more distinct items in the last 24 h, queues nothing more across separate opens of one board root at the same main sha and runs no job_step query, and seeds again for a new main sha [C7,P7]', (t) => {
  const { project, db, now, main, tree } = wideBoard(t);
  const answered = `main-test:${tree}:tests/answered.test.js:node --test`;
  jobs.createJob(db, { id: answered, kind: MAIN_TEST_JOB, base: tree, now });
  jobs.writeStep(db, answered, 'receipt', { id: answered, tree, file: 'tests/answered.test.js', command: 'node --test', verdict: 'red', failing: ['case'], signatures: [null], main, at: now }, { seq: 0, now });
  const queuedNow = seedWideMainTests({ db, gitRoot: project.repo }, { main, now });
  assert.deepEqual(queuedNow, [`main-test:${tree}:tests/wide.test.js:node --test`], 'only the file red for 12 items in the window and with no receipt is queued');
  const at = jobs.jobView(db, queuedNow[0]).steps.find(step => step.name === 'queued').payload;
  assert.deepEqual(at, { tree, file: 'tests/wide.test.js', command: 'node --test' }, 'the row keys the tree, file and command a gate looks up');
  // A later open of the same board root has a new db handle; it must read nothing and queue nothing at the same main.
  const second = reopened(t, project);
  const queries = [];
  const prepare = second.db.prepare.bind(second.db);
  second.db.prepare = (sql) => { queries.push(sql); return prepare(sql); };
  assert.deepEqual(seedWideMainTests(second, { main, now }), [], 'main has not moved, so nothing is queued again');
  assert.equal(queries.some(sql => /job_step/u.test(sql)), false, 'the repeat reads no job_step row');
  // A new main sha seeds again.
  writeFileSync(join(project.repo, 'next.txt'), 'next');
  project.git(project.repo, 'add', '-A');
  project.git(project.repo, 'commit', '-qm', 'chore: move main');
  const moved = project.git(project.repo, 'rev-parse', 'HEAD');
  const movedTree = project.git(project.repo, 'rev-parse', 'HEAD^{tree}');
  const again = seedWideMainTests({ db, gitRoot: project.repo }, { main: moved, now });
  assert.ok(again.includes(`main-test:${movedTree}:tests/wide.test.js:node --test`), 'a new main sha seeds the wide files again');
});

test('api.io-recheck.claim-path-seeds-once: clause 1: with the setting off a pull claim through boardJobQueueCall runs no seeding, and with it on the seeding runs once per board root and main sha [C7,P7]', (t) => {
  const { project, db, now, main, tree } = wideBoard(t);
  const board = { db, gitRoot: project.repo };
  const claim = options => boardJobQueueCall(board, { action: 'claim', runner: 'r-seed', capabilities: [] }, { mode: 'pull', now, ...options });
  const seeded = () => jobs.jobsOf(db, { kind: MAIN_TEST_JOB }).length;
  claim({});
  assert.equal(seeded(), 0, 'with the setting off the claim seeds nothing');
  claim({ seedWideMainTests: true });
  const once = seeded();
  assert.ok(once >= 1, 'with the setting on the claim seeds the wide files');
  claim({ seedWideMainTests: true });
  assert.equal(seeded(), once, 'a second claim at the same main seeds nothing more');
});

const passing = [{ file, name: 'main passes', passed: true, skipped: false }, { file, name: 'main also passes', passed: true, skipped: false }];
const budgetLine = `test file budget: ${file} took 166184ms, over its 120000ms test file budget (159693ms of its own at runner load 1.0x); split it or move it to the audit\n`;

/** The gate lookup over the board's keyed main receipts, as the CLI provides it. */
function lookupOver(tree) {
  return ({ db, cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(name => classifyGateRed(db, returnedMainReceipts(db), { tree, file: name, command,
    reds: cases.filter(row => row.file === name).map(row => row.name), now: 3000 })) });
}

/** A gate receipt red on one case of the file, signed as given. */
function gateRed(name, signature) {
  return { gate: { phases: [{ role: 'proof', status: 1, failures: [{ file, name }], failureSignatures: [signature] }] } };
}

test('api.io-recheck.budget-only-keys-cases: clause 1: a main-test run whose cases all pass but whose file is over its test-file budget keys a receipt naming the passing cases and the budget, so waiting gates re-judge [C7,#12692]', async t => {
  const tree = 'e'.repeat(40);
  const { verdict, tail } = await entryVerdict(formatTestOutcomes(id, passing) + budgetLine);
  assert.equal(verdict.failing, null);
  assert.deepEqual(verdict.budget, { tookMs: 166184, limitMs: 120000, passed: ['main passes', 'main also passes'], passedCount: 2 });
  const { board, job } = queued(t, tree);
  const result = applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  assert.deepEqual({ applied: result.applied, outcome: result.outcome, verdict: result.verdict }, { applied: true, outcome: 'recorded', verdict: 'red' });
  const [keyed] = returnedMainReceipts(board.db);
  assert.deepEqual(keyed.failing, [budgetCase(file).name]);
  assert.deepEqual(keyed.passed, ['main passes', 'main also passes']);
  assert.equal(keyed.budgetOnly, true);
  assert.deepEqual(keyed.budget, { tookMs: 166184, limitMs: 120000 });
  assert.equal(classifyGateRed(board.db, returnedMainReceipts(board.db), { tree, file, command, reds: ['main passes'], now: 3000 }).job, null, 'a recorded receipt queues no further job');
});

test('api.io-recheck.budget-only-no-mask: clause 2: an item failing a case main passed in a budget-only run reads as new; only the same budget failure reads main-owned [C7,#12692]', async t => {
  const tree = 'e'.repeat(40);
  const { tail } = await entryVerdict(formatTestOutcomes(id, passing) + budgetLine);
  const { board, job } = queued(t, tree);
  applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  board.gitRoot = '/fixture';
  const sign = 'd'.repeat(64);
  const own = compareGateWithMain(board, gateRed('main passes', sign), 'c'.repeat(40), lookupOver(tree));
  assert.deepEqual(own.cases.map(row => row.onMain), [false], 'a case main passed is the item\'s own, never main-owned');
  const over = budgetCase(file);
  const same = compareGateWithMain(board, gateRed(over.name, over.signature), 'c'.repeat(40), lookupOver(tree));
  assert.deepEqual(same.cases.map(row => row.onMain), [true], 'the same budget failure is main-owned');
  const other = budgetCase('tests/other.test.js');
  const different = compareGateWithMain(board, gateRed(other.name, other.signature), 'c'.repeat(40), lookupOver(tree));
  assert.deepEqual(different.cases.map(row => row.onMain), [false], 'another file\'s budget failure is not this one');
});

test('api.io-recheck.budget-only-unfinished: clause 3: a run that names no cases and did not finish writes no receipt, whether it lacks the budget line or the outcome frames [C7,#12692]', async t => {
  const tree = 'e'.repeat(40);
  for (const output of [formatTestOutcomes(id, passing), budgetLine, formatTestOutcomes(id, [...passing, { file, name: 'crashed', passed: false, skipped: false }]) + budgetLine]) {
    const { tail } = await entryVerdict(output);
    const { board, job } = queued(t, tree);
    assert.equal(applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 }).applied, false);
    assert.deepEqual(returnedMainReceipts(board.db), []);
  }
});
