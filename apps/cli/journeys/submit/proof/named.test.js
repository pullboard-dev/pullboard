/**
 * Submit runs the test files a frozen criterion or the brief's Test: list names, outside the affected selection, and the
 * review packet cites each file's cases from the exact-head gate receipt [C7,V4].
 */
import assert from 'node:assert/strict';
import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  markedTest,
  submittedItem,
} from '../../../tests/fixtures/submit/proof.js';

/** How the packet cites a run of the file a clause names: the file, or (#3696) the executed cases in it. */
const NAMED_FILE = ['clause names the file', 'case in the file the clause names', 'test cites the clause'];

test('clause 1: submit runs the test file the frozen criterion names and the one the brief Test: list names, though the change never imports them [C7,V4]', { timeout: 240_000 }, async (t) => {
  const { packet, dir } = await submittedItem(t, undefined, {
    criterion: '1. The page shows a greeting, proved by web/named.test.js [test]. 2. The visitor sees a farewell [test].',
    brief: 'Files: web/greet.js\nTest:\n- web/brief.test.js',
    files: dir => ({ 'web/named.test.js': markedTest(dir, 'named', 'the named file holds'), 'web/brief.test.js': markedTest(dir, 'brief', 'the listed file holds') }),
  });
  const ran = readFileSync(join(dir, 'named-ran.log'), 'utf8').split('\n').filter(Boolean).sort();
  assert.deepEqual([...new Set(ran)], ['brief', 'named'], 'the gate ran both bar-named files, which the affected-test selection never reaches');

  await t.test('clause 2: show --review lists each [test] clause with its named file outcome from the exact-head gate receipt, no gap [C7,V4]', () => {
    const [first, second] = packet.clauses;
    assert.ok(first.runs.some(run => run.file === 'web/named.test.js' && run.result === 'pass' && run.receipt && NAMED_FILE.includes(run.why)),
      `clause 1 cites its named file's run: ${JSON.stringify(first)}`);
    assert.ok(second.runs.some(run => run.file === 'web/brief.test.js' && run.result === 'pass' && run.receipt && run.why === "the brief's Test: list names the file"),
      `clause 2 cites the brief's Test: file run: ${JSON.stringify(second)}`);
    assert.deepEqual(packet.clauses.filter(clause => clause.gap).map(clause => [clause.n, clause.gap]), [], 'no clause is left with no recorded run');
  });
});

/**
 * A committed test file whose worker loses its own runtime self-report, as #3734's second-shard workers did: it removes
 * its `runtime-<pid>` record from the gate's capture folder, so the receipt's children never name it, then logs `lost`.
 */
function unreportedTest(dir, caseName) {
  return [
    "import { appendFileSync, readdirSync, rmSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { test } from 'node:test';",
    'const capture = process.env.PULLBOARD_RUNTIME_CAPTURE_DIR;',
    "const own = capture ? readdirSync(capture).filter(name => name.startsWith(`runtime-${process.pid}-`)) : [];",
    'for (const name of own) rmSync(join(capture, name));',
    `appendFileSync(${JSON.stringify(join(dir, 'named-ran.log'))}, own.length ? 'lost\\n' : 'kept\\n');`,
    `test(${JSON.stringify(caseName)}, () => {});`,
    '',
  ].join('\n');
}

/** The exact-head submit receipts the gate wrote for the item, read from the gate's own receipt files. */
function submitReceipts(repo, head) {
  const folder = join(repo, '.git', 'pullboard', 'gate-receipts');
  return readdirSync(folder).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')))
    .filter(receipt => receipt.kind === 'submit' && receipt.head === head);
}

test('clause 1: the exact-head submit receipt runs a file the frozen criterion names, outside the affected selection, and names its cases though its worker report is lost [C7,V4]', { timeout: 240_000, skip: 'PULL_GAP: pulled gate children carry no runtime capture dir; un-skip when the runner records test runtimes' }, async (t) => {
  const { packet, dir, repo, head } = await submittedItem(t, undefined, {
    criterion: '1. The job folder stays while its job runs, proved by web/folder-live.test.js [test]. 2. The sweep keeps its floor, proved by web/sweep.test.js [test].',
    files: dir => ({ 'web/folder-live.test.js': unreportedTest(dir, 'a long job mid-run keeps its folder'),
      'web/sweep.test.js': markedTest(dir, 'sweep', 'the sweep keeps its floor') }),
  });
  assert.deepEqual(readFileSync(join(dir, 'named-ran.log'), 'utf8').split('\n').filter(Boolean).sort(), ['lost', 'sweep'],
    'the gate ran both criterion-named files, and the folder-live worker lost its runtime report');
  const proof = submitReceipts(repo, head).find(receipt => receipt.proof?.submitPhase === 'proof');
  assert.ok(proof, `the gate wrote an exact-head proof receipt at ${head}`);
  const outcomes = proof.testOutcomes ?? [];
  assert.ok(outcomes.some(row => row.file === 'web/folder-live.test.js' && row.name === 'a long job mid-run keeps its folder' && row.passed),
    `the receipt names the criterion file's case: ${JSON.stringify(outcomes)}`);
  assert.ok(!(proof.proof.testRuntimes ?? []).some(row => row.file === 'web/folder-live.test.js'),
    "the receipt's children miss the file, as #3734's did");
  assert.ok((proof.proof.testRuntimes ?? []).some(row => row.file === 'web/sweep.test.js'), 'another child of the same receipt is reported');

  await t.test('clause 2: show --review lists the named-file case outcomes from the exact-head gate receipt for each clause, no gap [C7,V4]', () => {
    const [live, sweep] = packet.clauses;
    assert.equal(packet.head, head, 'the packet is for the exact submitted head');
    assert.ok(live.runs.some(run => run.file === 'web/folder-live.test.js' && run.test === 'a long job mid-run keeps its folder'
      && run.result === 'pass' && run.receipt === proof.id), `clause 1 cites the receipt's named case: ${JSON.stringify(live)}`);
    assert.ok(sweep.runs.some(run => run.file === 'web/sweep.test.js' && run.test === 'the sweep keeps its floor' && run.result === 'pass'),
      `clause 2 cites its named case: ${JSON.stringify(sweep)}`);
    assert.ok(!sweep.runs.some(run => run.test === 'a long job mid-run keeps its folder'), "a lost report never moves a case to another file's clause");
    assert.deepEqual(packet.clauses.filter(clause => clause.gap).map(clause => [clause.n, clause.gap]), [], 'no clause is left with no recorded run');
  });
});
