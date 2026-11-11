/** @pullboard-test-input source-tree */
/** Durable gate 22: main-red status is a receipt lookup keyed by main tree, test file and command [C7]. */
/** @pullboard-world-pin: clauses 1 and 2 read the shipped submit gate and its lookup to prove the production caller is switched. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { policyRepository } from '../../tests/fixtures/board/submit.js';
import {
  openBoard,
  closeBoard,
} from '../../../lib/src/logic/native.js';
import { jobView } from '../../../../packages/jobs/index.js';
import {
  mainRedLookup,
  classifyGateRed,
  MAIN_TEST_JOB,
} from '../../../../packages/drive/index.js';
import {
  mainRedKey,
  mainRedStatus,
} from '../../../../packages/receipt/index.js';
import {
  cacheFile,
  matchingMainFailures,
  receiptComparison,
  MAIN_FAILURE_SIGNATURE_VERSION,
} from '../../../../packages/landing/index.js';
import { splitBaseRed } from '../../../../packages/landing/index.js';
import { criterionMainReceipts } from '../../src/io/submit/receipt.js';

const files = privateFixtureFiles('pullboard-durable-mainred-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(':memory:');
  try { return body(board.db); } finally { closeBoard(board); }
}

/** Open a fresh real board file for an async body, closing it once the body settles. */
async function withBoardAsync(name, body) {
  const board = openBoard(':memory:');
  try { return await body(board.db); } finally { closeBoard(board); }
}

const at = { tree: 'tree-main-1', file: 'test/a.test.js', command: 'npm test --' };
const red = { id: 'mr-1', ...at, verdict: 'red', failing: ['case one', 'case two'] };

test('main-red status is read from the receipt keyed by (main tree, file, command); a missing receipt enqueues a main-test job [C7]', () => {
  assert.equal(mainRedKey(at.tree, at.file, at.command), mainRedKey(at.tree, at.file, at.command));
  assert.notEqual(mainRedKey(at.tree, at.file, at.command), mainRedKey('tree-main-2', at.file, at.command), 'a new main tree is a new key');
  assert.notEqual(mainRedKey(at.tree, at.file, at.command), mainRedKey(at.tree, at.file, 'make test'), 'another command is a new key');
  assert.throws(() => mainRedKey(at.tree, '', at.command), { code: 'MAIN_RED_KEY' });

  assert.deepEqual(mainRedStatus([red], at), { key: mainRedKey(at.tree, at.file, at.command), status: 'red', receipt: 'mr-1', failing: ['case one', 'case two'] });
  assert.equal(mainRedStatus([red], { ...at, tree: 'tree-main-2' }).status, 'missing', 'a receipt for another tree never answers');

  withBoard('lookup', (db) => {
    const found = mainRedLookup(db, [red], { ...at, now: 1000 });
    assert.equal(found.status, 'red');
    assert.equal(found.job, null, 'a present receipt enqueues nothing');

    const missing = { ...at, tree: 'tree-main-2', now: 2000 };
    const first = mainRedLookup(db, [red], missing);
    assert.equal(first.status, 'missing');
    assert.equal(first.job, `${MAIN_TEST_JOB}:${mainRedKey('tree-main-2', at.file, at.command)}`);
    const job = jobView(db, first.job);
    assert.equal(job.kind, MAIN_TEST_JOB);
    assert.equal(job.step, 'queued', 'the job waits for a driver: nothing ran');
    assert.equal(job.leaseOwner, null, 'no process took it');
    assert.deepEqual(job.steps.map((step) => step.payload), [{ tree: 'tree-main-2', file: at.file, command: at.command }]);

    const again = mainRedLookup(db, [red], { ...missing, now: 3000 });
    assert.equal(again.job, first.job, 'a second ask for the same key reuses the one job');
    assert.equal(jobView(db, first.job).steps.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE job_kind = ?').get(MAIN_TEST_JOB).n, 1);
  });
});

test('a gate red only on cases red in main\'s receipt is main\'s own red, with the receipt id in the result [C7]', () => {
  withBoard('classify', (db) => {
    const own = classifyGateRed(db, [red], { ...at, reds: ['case two'] });
    assert.deepEqual(own, { file: at.file, owner: 'main', receipt: 'mr-1', own: [], code: 'MAIN_OWN_RED', job: null });

    const mixed = classifyGateRed(db, [red], { ...at, reds: ['case two', 'case three'] });
    assert.equal(mixed.owner, 'candidate', 'a red main does not name is the candidate\'s own');
    assert.deepEqual(mixed.own, ['case three']);
    assert.equal(mixed.receipt, 'mr-1');

    const green = classifyGateRed(db, [{ ...red, id: 'mr-g', verdict: 'green', failing: [] }], { ...at, reds: ['case one'] });
    assert.equal(green.owner, 'candidate', 'main green on the file means the red is the candidate\'s');
    assert.equal(green.receipt, 'mr-g');

    const unknown = classifyGateRed(db, [], { ...at, reds: ['case one'] });
    assert.equal(unknown.owner, 'unknown');
    assert.equal(unknown.code, 'MAIN_RECEIPT_MISSING');
    assert.equal(jobView(db, unknown.job).step, 'queued', 'with no receipt the main-test job is queued, never guessed');
  });
});

/** A real git repo whose one commit configures a focused test command, with main's comparison receipts written. */
function mainRepo(name, outcomes) {
  const root = join(files.root, name);
  mkdirSync(root);
  policyRepository(root);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: {}, affectedTests: 'npm test --' }));
  runFixtureGit(['-C', root, 'add', 'pullboard.json']);
  runFixtureGit(['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'main']);
  const commit = runFixtureGit(['-C', root, 'rev-parse', 'HEAD']);
  const tree = runFixtureGit(['-C', root, 'rev-parse', 'HEAD^{tree}']);
  const cache = cacheFile(root);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ version: 2, entries: { [commit]: outcomes } }), { mode: 0o600 });
  return { root, commit, tree };
}

const SIG = 'a'.repeat(64);
const failing = (name) => ({ file: at.file, name, signature: SIG });

test('the landing diagnose step reads base main from its receipt, and a missing receipt enqueues one main-test job [C7]', async () => {
  const box = mainRepo('landing-lookup', { [at.file]: { result: 'red', failures: [failing('case one')], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: 'mr-9' } });
  await withBoardAsync('landing', async (db) => {
    const measured = [];
    const compare = receiptComparison({ db, now: () => 5000, measure: async (_root, profile) => { measured.push(profile.tests.map((row) => row.file)); return { main: box.commit, files: [] }; } });
    const found = await compare(box.root, { tests: [{ file: at.file, passed: false }] }, undefined, '', { commit: box.commit, detailed: true });
    assert.deepEqual(measured, [], 'a file with a receipt is never run on main again');
    assert.deepEqual(found.receipts, ['mr-9']);
    assert.equal(found.files[0].result, 'red');

    const state = { board: { db }, batch: { root: box.root, base: box.commit }, say() {} };
    const split = await splitBaseRed(state, [{ file: at.file, name: 'case one' }, { file: at.file, name: 'case new' }], compare, () => true, () => null);
    assert.deepEqual(split.known, [{ file: at.file, name: 'case one' }], 'a case main\'s receipt names is main\'s own');
    assert.deepEqual(split.own, [{ file: at.file, name: 'case new' }], 'a case the receipt does not name stays the batch\'s');

    await compare(box.root, { tests: [{ file: 'test/b.test.js', passed: false }] }, undefined, '', { commit: box.commit, detailed: true });
    assert.deepEqual(measured, [['test/b.test.js']], 'a missing receipt is measured once through the port, no refresh process');
    const key = mainRedKey(box.tree, 'test/b.test.js', 'npm test --');
    const job = jobView(db, `${MAIN_TEST_JOB}:${key}`);
    assert.equal(job.kind, MAIN_TEST_JOB);
    assert.deepEqual(job.steps.map((step) => step.payload), [{ tree: box.tree, file: 'test/b.test.js', command: 'npm test --' }]);
  });
});

test('the submit gate counts a red as main\'s own only when main\'s receipt names every failing case [C7]', () => {
  const comparison = { main: 'm', files: [{ file: at.file, result: 'red', failures: [failing('case one'), failing('case two')], receiptId: 'mr-1' }] };
  const own = [failing('case one'), failing('case two')];
  assert.deepEqual(matchingMainFailures(own, comparison, 'm'), { main: 'm', failures: own }, 'every case named: main\'s own red');
  assert.equal(matchingMainFailures([failing('case one'), failing('case three')], comparison, 'm'), null, 'one case main does not name refuses');
  const green = { main: 'm', files: [{ file: at.file, result: 'green', failures: [], receiptId: 'mr-g' }] };
  assert.equal(matchingMainFailures([failing('case one')], green, 'm'), null, 'a green receipt never excuses a red');
  assert.equal(matchingMainFailures([failing('case one')], { main: 'm', files: [] }, 'm'), null, 'no receipt never excuses a red');
});

/** The submit command's criterion-red block: from the red frozen check's cases to the Main red repair fallback. */
function criterionBlock() {
  const source = readFileSync(join(import.meta.dirname, '../../src/io/commands/submit.js'), 'utf8');
  const start = source.indexOf('if (criterionCases) {');
  const end = source.indexOf('// A case an open Main red repair', start);
  assert.ok(start > 0 && end > start, 'the submit gate still has its criterion-red block');
  return { source, block: source.slice(start, end) };
}

test('clause 1: the submit gate reads main-red status from the keyed receipt [C7]', async () => {
  const { block } = criterionBlock();
  assert.match(block, /criterionMainReceipts\(\{ root, db: board\.db, main: mainFailureBase, cases: criterionCases \}\)/u, 'submit classifies criterion reds through the receipt lookup');
  assert.doesNotMatch(block, /compareMainFailures/u, 'submit no longer runs the refresh comparison for criterion reds');
  const helper = readFileSync(join(import.meta.dirname, '../../src/io/submit/receipt.js'), 'utf8');
  assert.match(helper, /import \{ classifyGateRed \} from '..\/..\/..\/..\/..\/packages\/drive\/index.js'/u, 'the lookup is the drive cell\'s classifyGateRed');
  assert.deepEqual([...helper.matchAll(/^import \{ (\w+) \}/gmu)].map((match) => match[1]), ['classifyGateRed', 'mainReceipts'], 'the lookup imports no measuring or process code');

  const box = mainRepo('submit-lookup', { [at.file]: { result: 'red', failures: [failing('case one')], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: 'mr-9' } });
  withBoard('submit-lookup', (db) => {
    const found = criterionMainReceipts({ root: box.root, db, main: box.commit, cases: [failing('case one')], now: 7000 });
    assert.deepEqual(found.classes.map(({ file, owner, receipt }) => ({ file, owner, receipt })), [{ file: at.file, owner: 'main', receipt: 'mr-9' }], 'keyed by main tree, file and command');
    assert.equal(found.comparison.files[0].result, 'red');
    assert.deepEqual(found.jobs, [], 'a present receipt enqueues nothing');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 0);

    const missing = criterionMainReceipts({ root: box.root, db, main: box.commit, cases: [{ file: 'test/b.test.js', name: 'case b', signature: SIG }], now: 8000 });
    assert.equal(missing.comparison, null, 'a missing receipt never excuses the red');
    assert.deepEqual(missing.missing, ['test/b.test.js']);
    const key = mainRedKey(box.tree, 'test/b.test.js', 'npm test --');
    assert.deepEqual(missing.jobs, [`${MAIN_TEST_JOB}:${key}`]);
    const job = jobView(db, missing.jobs[0]);
    assert.equal(job.kind, MAIN_TEST_JOB);
    assert.equal(job.step, 'queued', 'the main-test job waits for a driver: no refresh ran');
    assert.equal(job.leaseOwner, null, 'no process took the job');
    assert.deepEqual(job.steps.map((step) => step.payload), [{ tree: box.tree, file: 'test/b.test.js', command: 'npm test --' }]);
    assert.match(missing.reason, /main-test job .* is queued/u);
  });
});

test('clause 2: a main-receipt-only red is main\'s own red [C7]', () => {
  const { source, block } = criterionBlock();
  assert.match(block, /criterionReceipts = lookup\.classes\.map/u, 'submit keeps each file\'s main receipt');
  assert.match(source, /criterionMatched && criterionReceipts\.length \? \{ mainRedReceipts: criterionReceipts \}/u, 'the gate result names the receipt ids');

  const box = mainRepo('submit-classify', { [at.file]: { result: 'red', failures: [failing('case one'), failing('case two')], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: 'mr-7' } });
  withBoard('submit-classify', (db) => {
    const cases = [failing('case one'), failing('case two')];
    const mainOwn = criterionMainReceipts({ root: box.root, db, main: box.commit, cases });
    assert.deepEqual(mainOwn.classes.map(({ owner, receipt, code }) => ({ owner, receipt, code })), [{ owner: 'main', receipt: 'mr-7', code: 'MAIN_OWN_RED' }]);
    assert.deepEqual(mainOwn.comparison.receipts, ['mr-7'], 'the receipt id travels with the comparison');
    assert.deepEqual(matchingMainFailures(cases, mainOwn.comparison, box.commit), { main: box.commit, failures: cases }, 'the gate records it as main\'s own red');

    const mixed = criterionMainReceipts({ root: box.root, db, main: box.commit, cases: [failing('case one'), failing('case new')] });
    assert.equal(mixed.classes[0].owner, 'candidate', 'a case main\'s receipt does not name is the candidate\'s');
    assert.equal(matchingMainFailures([failing('case one'), failing('case new')], mixed.comparison, box.commit), null, 'such a red refuses');
  });
});
