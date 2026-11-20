/**
 * Fixture for the submit-proof journeys: an item citing spec row G1 whose gate is a committed test the item never touches,
 * submitted on a real repo and board, and its settled review packet read back [V4,C7].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { createE2eHelpers } from '../e2e.js';
import {
  FIXTURE_MODEL,
  fixtureProjectPolicy,
} from '../testkit.js';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';
import { settleSubmit } from './settle.js';
import { TIMING_RUN_ID_ENV } from '../../../../../packages/gate/heavy.js';

const helpers = createE2eHelpers();
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

export const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';
export const ROW_GATE = 'web/row-gate.test.js';

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
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../../../../../packages/gate/heavy.js', import.meta.url).href)};
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
export async function submittedItem(t, gateCases = ["test('the row gate holds', () => {});"], { criterion = '1. The page shows a greeting [test].', brief = null, files = () => ({}) } = {}) {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  box.env.PULLBOARD_MODEL = FIXTURE_MODEL;
  t.after(() => stopFixtureLocalRunner(box.env.PULLBOARD_MACHINE_HOME));
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submitGate = 'landing';
  config.affectedTests = RUN;
  config.gate = `${RUN} web/packet.test.js`;
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  fixtureProjectPolicy(box.repo, { config, spec: spec.replace('The page renders. | gate: web test', `The page renders. | gate: ${ROW_GATE}`) });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
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
  const submitted = await settleSubmit(t, box, JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out));
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');
  const packet = JSON.parse((await ok(box, box.repo, 'show', String(id), '--review', '--json')).out);
  return { packet, ranRowGate: existsSync(marker), dir: box.dir, repo: box.repo, head: box.git(builder, 'rev-parse', 'HEAD').trim() };
}

/** A committed test file the item's change never imports, which appends `name` to a marker file when it runs. */
export function markedTest(dir, name, caseName) {
  return [
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `appendFileSync(${JSON.stringify(join(dir, 'named-ran.log'))}, ${JSON.stringify(`${name}\n`)});`,
    `test(${JSON.stringify(caseName)}, () => {});`,
    '',
  ].join('\n');
}

