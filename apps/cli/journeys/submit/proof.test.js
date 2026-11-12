/**
 * Submit runs each cited spec row's gate test, so the frozen row clause has a named run in the review packet [V4,C7].
 * A real repo and board: row G1's gate is a committed test file, the item cites G1, and none of the item's own tests
 * cites the row, so only the gate test can prove it.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { TIMING_RUN_ID_ENV } from '../../../../packages/gate/index.js';

const helpers = createE2eHelpers();
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';
const ROW_GATE = 'web/row-gate.test.js';

/** Run the actual CLI and keep its complete output when an assertion fails. */
async function ok(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result;
}

/** Commit fixture bytes through the installed native Git hooks. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', message);
}

/** The repo runner's reporter: TAP plus native per-test outcome frames, so receipts record each file's tests. */
function outcomeReporter(box) {
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../../../../packages/gate/index.js', import.meta.url).href)};
export default async function* report(events) {
  const collector = testOutcomeCollector(process.cwd());
  let count = null;
  async function* observe() {
    for await (const event of events) {
      collector.observe(event);
      if (event.type === 'test:summary') count = event.data.counts.tests;
      yield event;
    }
  }
  for await (const chunk of tap(observe())) yield chunk;
  yield formatTestOutcomes(process.env[${JSON.stringify(TIMING_RUN_ID_ENV)}], collector.finish(count !== null, count));
}
`);
}

/**
 * Submit an item citing G1, whose row gate is a committed test the item does not touch, and read its packet.
 * `gateCases` are the gate file's test lines: a passing case by default. `criterion` and `brief` are the item's bar, and
 * `files(dir)` returns more committed files, keyed by repo path, that the item's change never touches.
 */
async function submittedItem(gateCases = ["test('the row gate holds', () => {});"], { criterion = '1. The page shows a greeting [test].', brief = null, files = () => ({}) } = {}) {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  box.env.PULLBOARD_MODEL = 'fixture-model';
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  config.gate = `${RUN} web/packet.test.js`;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  writeFileSync(join(box.repo, 'SPEC.md'), spec.replace('The page renders. | gate: web test', `The page renders. | gate: ${ROW_GATE}`));
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  const marker = join(box.dir, 'row-gate-ran.log');
  writeFileSync(join(box.repo, ROW_GATE), [
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
    ...gateCases,
    '',
  ].join('\n'));
  for (const [file, source] of Object.entries(files(box.dir))) writeFileSync(join(box.repo, file), source);
  outcomeReporter(box);
  commit(box, box.repo, 'chore: seed the spec-row gate fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  await ok(box, builder, 'join', 'web');
  const added = JSON.parse((await ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--route', 'mid',
    '--criterion', criterion, ...(brief ? ['--brief', brief] : []), '--check', `${RUN} web/packet.test.js`, '--json')).out);
  const id = added.item.item_id;
  await ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('clause 1: the page shows a greeting', () => assert.match(greet('Ada'), /^Hello/u));",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor [G1]');
  await ok(box, builder, 'fact', String(id), 'note', "clause 1 [test]: web/packet.test.js 'clause 1: the page shows a greeting'");
  rmSync(marker, { force: true });
  const submitted = JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out);
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');
  const packet = JSON.parse((await ok(box, box.repo, 'show', String(id), '--review', '--json')).out);
  return { packet, ranRowGate: existsSync(marker), dir: box.dir, repo: box.repo, head: box.git(builder, 'rev-parse', 'HEAD').trim() };
}

test('clause 1: a submit for an item citing a spec row runs that row\'s gate test file in its recorded proof [V4,C7]', { timeout: 240_000 }, async (t) => {
  const { packet, ranRowGate } = await submittedItem();
  assert.equal(ranRowGate, true, `submit ran ${ROW_GATE}, the gate of cited row G1`);
  const row = packet.clauses.find(clause => clause.id === 'G1');
  assert.ok(row, 'the packet lists the frozen G1 clause');
  assert.ok(row.runs.some(run => run.file === ROW_GATE && run.result === 'pass'), `the proof recorded a passing run of ${ROW_GATE}: ${JSON.stringify(row)}`);

  await t.test('clause 2: the review packet cites the row\'s gate run for the spec-row clause, so no clause is left without a run [V4,C7]', () => {
    assert.equal(row.gap, undefined, 'the G1 clause has no evidence gap');
    assert.ok(row.runs.some(run => run.why === "the row's gate test" && run.test === 'the row gate holds'), 'the run is the gate file\'s named, executed case');
    assert.deepEqual(packet.clauses.filter(clause => !clause.runs.length).map(clause => clause.n), [], 'every clause cites a recorded run');
  });
});

test('clause 2: a row gate run with only skipped cases, or none, leaves the spec-row clause unproved [V4,C7]', { timeout: 300_000 }, async (t) => {
  for (const [kind, cases] of [['all skipped', ["test('the row gate holds', { skip: true }, () => {});"]], ['zero cases', []]]) {
    await t.test(`clause 2: ${kind}`, async () => {
      const { packet, ranRowGate } = await submittedItem(cases);
      assert.equal(ranRowGate, true, `submit still ran ${ROW_GATE}`);
      const row = packet.clauses.find(clause => clause.id === 'G1');
      assert.deepEqual(row.runs, [], `a ${kind} gate run proves nothing: ${JSON.stringify(row)}`);
      assert.equal(row.gap, 'no recorded run');
    });
  }
});

/** A committed test file the item's change never imports, which appends `name` to a marker file when it runs. */
function markedTest(dir, name, caseName) {
  return [
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `appendFileSync(${JSON.stringify(join(dir, 'named-ran.log'))}, ${JSON.stringify(`${name}\n`)});`,
    `test(${JSON.stringify(caseName)}, () => {});`,
    '',
  ].join('\n');
}

/** How the packet cites a run of the file a clause names: the file, or (#3696) the executed cases in it. */
const NAMED_FILE = ['clause names the file', 'case in the file the clause names', 'test cites the clause'];

test('clause 1: submit runs the test file the frozen criterion names and the one the brief Test: list names, though the change never imports them [C7,V4]', { timeout: 240_000 }, async (t) => {
  const { packet, dir } = await submittedItem(undefined, {
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

test('clause 1: the exact-head submit receipt runs a file the frozen criterion names, outside the affected selection, and names its cases though its worker report is lost [C7,V4]', { timeout: 240_000 }, async (t) => {
  const { packet, dir, repo, head } = await submittedItem(undefined, {
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
