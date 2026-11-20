/** The review packet maps gate outcomes of cases a test file loads from fixture modules to their clauses [V4,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { joinFixtureSeat } from '../../../fixtures/testkit.js';
import { settleSubmit } from '../../../fixtures/submit/settle.js';
import { TIMING_RUN_ID_ENV } from '../../../../../../packages/gate/heavy.js';

const helpers = createE2eHelpers();
// A green submit starts the detached verification comparison, which can still be writing the board directory;
// rmSync's own bounded retries wait out its ENOTEMPTY instead of a timer in the test.
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

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

/**
 * A fixture reporter that prints TAP and the gate's native per-test outcome frames, the way the repo's own runner
 * does, so the gate's receipt records each case at the file Node attributes it to: for a fixture case, the fixture.
 */
function outcomeReporter(box) {
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../../../../../../packages/gate/heavy.js', import.meta.url).href)};
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

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';

test('cli.journeys-fact-review-packet-cases-fixture.a-clause-case-defined-in-a: clause 1: a clause case defined in a fixture file is mapped from a gate run [V4,C7]', { timeout: 240_000 }, async t => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  // The fixture's own `node --test` must run its files, not see this runner's context and skip them.
  delete box.env.NODE_TEST_CONTEXT;
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  outcomeReporter(box);
  commit(box, box.repo, 'chore: seed review packet fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  assert.equal(joinFixtureSeat(box, builder, 'web').code, 0, 'the builder seat joins');
  const added = JSON.parse((await ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1',
    '--criterion', '1. The page shows a greeting [test] 2. Legacy callers keep working [test]',
    '--check', `${RUN} web/packet.test.js`, '--json')).out);
  const id = added.item.item_id;
  await ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  // The clause cases live in fixture modules, one beside the test file and one in a subfolder; Node attributes
  // each case to the fixture file that called test(), not to the test file the gate ran.
  mkdirSync(join(builder, 'web/cases'));
  writeFileSync(join(builder, 'web/greeting.fixture.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('clause 1: a greeting is shown [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    '',
  ].join('\n'));
  writeFileSync(join(builder, 'web/cases/legacy.fixture.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from '../greet.js';",
    "test('clause 2: old callers still get a string [G1]', () => assert.equal(typeof greet('Ada'), 'string'));",
    '',
  ].join('\n'));
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import './greeting.fixture.js';",
    "import './cases/legacy.fixture.js';",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  for (const n of [1, 2]) await ok(box, builder, 'fact', String(id), 'note', `clause ${n} [test]: web/packet.test.js, run by the check for clause ${n}`);
  // A pulled submit returns queued; settle its gate before reading the result [V4,C7].
  const submitted = await settleSubmit(t, { repo: box.repo, env: box.env, run: box.runLocal }, JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out));
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');
  // A pulled gate's receipt posts on the board host, which holds no checkout; the first review read builds and stores the packet [V4,C7].
  await ok(box, box.repo, 'show', String(id), '--review');
  const packet = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'review-packets', String(id), `${head}.json`), 'utf8'));
  const [greeting, legacy] = packet.clauses;
  const cited = (clause, name, source) => clause.runs.find(run => run.test === name && run.why === 'test cites the clause'
    && run.file === 'web/packet.test.js' && run.source === source && run.result === 'pass');
  assert.ok(cited(greeting, 'clause 1: a greeting is shown [G1]', 'web/greeting.fixture.js'),
    `clause 1 cites its fixture case from the gate run: ${JSON.stringify(greeting.runs)}`);
  assert.ok(cited(legacy, 'clause 2: old callers still get a string [G1]', 'web/cases/legacy.fixture.js'),
    `clause 2 cites its fixture case in a subfolder: ${JSON.stringify(legacy.runs)}`);
  assert.ok(!greeting.runs.some(run => run.test === 'clause 2: old callers still get a string [G1]'), 'a fixture case maps only to the clause it cites');
});
