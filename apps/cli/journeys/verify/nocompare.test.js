/** A reviewer is never told to run verify --compare, and accepts on the item's gate receipts while the comparison is unavailable [C7,#2991]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixturePolicy } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { TIMING_RUN_ID_ENV } from '../../../../packages/gate/heavy.js';

const helpers = createE2eHelpers();
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';
const REPORTER = `import { tap } from 'node:test/reporters';
import { testOutcomeCollector, formatTestOutcomes } from ${JSON.stringify(new URL('../../../../packages/gate/heavy.js', import.meta.url).href)};
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
`;

/** Run the production dispatcher in this process and keep its complete output when an assertion fails. */
async function ok(box, cwd, ...args) {
  const result = await box.runIn(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result;
}

test('cli.journeys-verify-nocompare.show-and-next-verify-never-tell: clause 1: show and next --verify never tell a reviewer to run verify --compare, and clause 2: the reviewer accepts on the gate receipts while the comparison is unavailable [C7]', { timeout: 240_000 }, async t => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  fixturePolicy(box, { submitGate: 'landing', affectedTests: RUN });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), REPORTER);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed no-compare fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  assert.equal((await joinFixtureSeat(box, builder, 'web', { run: box.runIn })).code, 0);
  const added = JSON.parse((await ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1',
    '--criterion', '1. The visitor is named [test]',
    '--check', `${RUN} web/nocompare.test.js`, '--json')).out);
  const id = added.item.item_id;
  await ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/nocompare.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('clause 1: the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    '',
  ].join('\n'));
  box.git(builder, 'add', '-A');
  box.git(builder, 'commit', '-q', '-m', 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  await ok(box, builder, 'fact', String(id), 'note', 'clause 1 [test]: web/nocompare.test.js, run by the check for clause 1');
  assert.equal((await settleSubmit(t, box, JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out))).gate.green, true, 'the fixture gate is green');

  const reviewer = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  assert.equal((await joinFixtureSeat(box, reviewer, 'api', { run: box.runIn })).code, 0);
  // The fixture has no runner, so the comparison is recorded unavailable: the case the reviewer text must not turn into an instruction.
  const compared = await box.runIn(reviewer, 'verify', String(id), '--compare');
  assert.match(`${compared.out}${compared.err}`, /comparison unavailable/u, 'the fixture comparison is unavailable');
  const next = await ok(box, reviewer, 'next', '--verify', String(id));
  const shown = await ok(box, box.repo, 'show', String(id));
  const review = await ok(box, box.repo, 'show', String(id), '--review');
  for (const [name, text] of [['next --verify', next.out + next.err], ['show', shown.out + shown.err], ['show --review', review.out + review.err]]) {
    assert.doesNotMatch(text, /--compare/u, `clause 1: ${name} gives a reviewer no verify --compare instruction`);
  }
  const accepted = await ok(box, reviewer, 'verify', String(id), 'accept', '--note', 'the item gate receipts cover clause 1; the comparison was unavailable');
  assert.match(accepted.out, /accept/iu, 'clause 2: accept goes through on the gate receipts');
});
