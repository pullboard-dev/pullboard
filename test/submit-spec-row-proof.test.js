/**
 * Submit runs each cited spec row's gate test, so the frozen row clause has a named run in the review packet [V4,C7].
 * A real repo and board: row G1's gate is a committed test file, the item cites G1, and none of the item's own tests
 * cites the row, so only the gate test can prove it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { TIMING_RUN_ID_ENV } from '../packages/gate/index.js';

const helpers = createE2eHelpers();
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';
const ROW_GATE = 'web/row-gate.test.js';

/** Run the actual CLI and keep its complete output when an assertion fails. */
function ok(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
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
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../packages/gate/index.js', import.meta.url).href)};
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
 * `gateCases` are the gate file's test lines: a passing case by default.
 */
function submittedItem(gateCases = ["test('the row gate holds', () => {});"]) {
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
  outcomeReporter(box);
  commit(box, box.repo, 'chore: seed the spec-row gate fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  ok(box, builder, 'join', 'web');
  const added = JSON.parse(ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--route', 'mid',
    '--criterion', '1. The page shows a greeting [test].', '--check', `${RUN} web/packet.test.js`, '--json').out);
  const id = added.item.item_id;
  ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('clause 1: the page shows a greeting', () => assert.match(greet('Ada'), /^Hello/u));",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor [G1]');
  ok(box, builder, 'fact', String(id), 'note', "clause 1 [test]: web/packet.test.js 'clause 1: the page shows a greeting'");
  rmSync(marker, { force: true });
  const submitted = JSON.parse(ok(box, builder, 'submit', String(id), '--no-next', '--json').out);
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');
  const packet = JSON.parse(ok(box, box.repo, 'show', String(id), '--review', '--json').out);
  return { packet, ranRowGate: existsSync(marker) };
}

test('clause 1: a submit for an item citing a spec row runs that row\'s gate test file in its recorded proof [V4,C7]', { timeout: 240_000 }, async (t) => {
  const { packet, ranRowGate } = submittedItem();
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
    await t.test(`clause 2: ${kind}`, () => {
      const { packet, ranRowGate } = submittedItem(cases);
      assert.equal(ranRowGate, true, `submit still ran ${ROW_GATE}`);
      const row = packet.clauses.find(clause => clause.id === 'G1');
      assert.deepEqual(row.runs, [], `a ${kind} gate run proves nothing: ${JSON.stringify(row)}`);
      assert.equal(row.gap, 'no recorded run');
    });
  }
});
