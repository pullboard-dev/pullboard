/** Submit inspects every numbered clause, and review reuses its named evidence [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { TIMING_RUN_ID_ENV } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const RUN = 'node --test --test-reporter=./web/outcome-reporter.js web/inspection.test.js';
const CRITERION = 'The submitted page meets its bar:\n1) The heading is present [test]\n2) The count appears [test]\n3) The page fits at 375px [test]';

/** Run a Pullboard command and fail with its full output when it is refused. */
async function ok(box, cwd, ...args) {
  const result = (await box.runLocal(cwd, ...args));
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result;
}

/** Commit fixture files with the repository's real Git hooks. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  box.git(cwd, 'commit', '-q', '-m', message);
}

/** Install a TAP reporter that records real per-test gate outcomes for the review packet. */
function outcomeReporter(box) {
  const gate = new URL('../../../../packages/gate/index.js', import.meta.url).href;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), [
    "import { tap } from 'node:test/reporters';",
    `import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(gate)};`,
    'export default async function* report(events) {',
    '  const collector = testOutcomeCollector(process.cwd());',
    '  let count = null;',
    '  async function* observe() {',
    '    for await (const event of events) {',
    '      collector.observe(event);',
    "      if (event.type === 'test:summary') count = event.data.counts.tests;",
    '      yield event;',
    '    }',
    '  }',
    '  for await (const chunk of tap(observe())) yield chunk;',
    `  yield formatTestOutcomes(process.env[${JSON.stringify(TIMING_RUN_ID_ENV)}], collector.finish(count !== null, count));`,
    '}',
    '',
  ].join('\n'));
}

test('submit requires named evidence for every clause and the reviewer packet binds each case [C7]', { timeout: 240_000 }, async () => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.verify?.inspectClauses, undefined, 'the fixture does not opt in to clause inspection');
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  // The board's model table determines seat routes since b95e1aa538.
  config.modelTiers = [{ contains: 'inspection-', route: 'strong' }];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  outcomeReporter(box);
  commit(box, box.repo, 'chore: record clause inspection runner');

  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', builder, '-b', 'web/inspection');
  (await ok(box, builder, 'join', 'web', '--model', 'inspection-fixture'));
  const added = JSON.parse((await ok(box, box.repo, 'add', 'web', 'Inspect every clause', '--specs', 'G1', '--criterion', CRITERION,
    '--check', RUN, '--route', 'strong', '--brief', 'Files:\n- web/page.html\nTest:\n- each named case cites its clause', '--json')).out);
  const id = added.item.item_id;
  (await ok(box, builder, 'claim', String(id)));
  mkdirSync(join(builder, 'web'), { recursive: true });
  writeFileSync(join(builder, 'web/page.html'), '<h1>Dashboard</h1><p>Count: 3</p><p>Fits at 375px.</p>\n');
  writeFileSync(join(builder, 'web/inspection.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "const page = readFileSync('web/page.html', 'utf8');",
    "test('clause 1: the heading is present', () => assert.match(page, /Dashboard/u));",
    "test('clause 2: the count appears', () => assert.match(page, /Count: 3/u));",
    "test('clause 3: the page fits at 375px', () => assert.match(page, /Fits at 375px/u));",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): inspect each numbered clause [G1]');

  const missing = (await box.runLocal(builder, 'submit', String(id), '--no-next'));
  assert.notEqual(missing.code, 0, 'an uninspected criterion cannot submit');
  assert.match(missing.err, /CLAUSE_UNTICKED/u);
  assert.match(missing.err, /clause 1 \(The heading is present/u);
  (await ok(box, builder, 'fact', String(id), 'note', 'clause 1 [test]: web/inspection.test.js :: clause 2: the count appears'));
  const wrongCase = (await box.runLocal(builder, 'submit', String(id), '--no-next'));
  assert.notEqual(wrongCase.code, 0, 'a different clause case is not evidence for clause 1');
  assert.match(wrongCase.err, /clause 1 .*named test case citing clause 1/u);
  for (const [number, title] of [[1, 'the heading is present'], [2, 'the count appears'], [3, 'the page fits at 375px']]) {
    (await ok(box, builder, 'fact', String(id), 'note', `clause ${number} [test]: web/inspection.test.js :: clause ${number}: ${title}`));
  }
  const submitted = JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out);
  assert.equal(submitted.gate.green, true, 'the submit gate ran the named clause cases');
  const detail = (await ok(box, box.repo, 'show', String(id), '--detail')).out;
  assert.match(detail, /inspection, clause by clause:/u, 'submit records its evidence checklist for the reviewer');
  for (const number of [1, 2, 3]) assert.match(detail, new RegExp(`clause ${number}:`));

  const packet = JSON.parse((await ok(box, box.repo, 'show', String(id), '--review', '--json')).out);
  assert.deepEqual(packet.clauses.slice(0, 3).map(clause => clause.n), [1, 2, 3]);
  for (const [index, title] of ['clause 1: the heading is present', 'clause 2: the count appears', 'clause 3: the page fits at 375px'].entries()) {
    const clause = packet.clauses[index];
    assert.ok(clause.runs.some(run => run.result === 'pass' && run.test === title), `clause ${index + 1} points to its named passing case`);
  }

  const reviewer = join(box.dir, 'web-reviewer');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  (await ok(box, reviewer, 'join', 'api', '--model', 'inspection-reviewer'));
  const badClause = (await box.runLocal(reviewer, 'verify', String(id), 'reject', '--reason', 'TEST_FAILURE', '--clause', 'a different clause',
    '--note', 'the reviewer must name the missed requirement', '--no-next'));
  assert.notEqual(badClause.code, 0, 'rejecting without a frozen checklist clause is refused');
  assert.match(badClause.err, /BAR_CLAUSE_UNKNOWN/u);
  (await ok(box, reviewer, 'verify', String(id), 'reject', '--reason', 'TEST_FAILURE', '--clause', 'The page fits at 375px [test]',
    '--note', 'the responsive requirement needs another review', '--no-next'));
  const rejected = JSON.parse((await ok(box, box.repo, 'show', String(id), '--json')).out).verdicts.at(-1);
  assert.equal(rejected.verdict_decision, 'REJECT');
  assert.equal(rejected.clause, 'The page fits at 375px [test]');
});
