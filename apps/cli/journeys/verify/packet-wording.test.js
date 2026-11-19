/** The review packet says what covers each clause, and accept says what was read (UX F6, #6563). */
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
import { TIMING_RUN_ID_ENV } from '../../../../packages/gate/index.js';

const helpers = createE2eHelpers();
after(() => {
  for (const dir of helpers.sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 150, retryDelay: 200 });
});

const RUN = 'node --test --test-reporter=./web/outcome-reporter.js';
const REPORTER = `import { tap } from 'node:test/reporters';
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
`;

/** Run the production dispatcher in this process and keep its complete output when an assertion fails. */
async function ok(box, cwd, ...args) {
  const result = await box.runIn(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}\n${result.out}`);
  return result;
}

test('cli.journeys-verify-packet-wording.the-packet-names-what-covers-a: clauses 1-3: the packet names what covers a clause, what does not, and accept says what was read [F6]', { timeout: 240_000 }, async t => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  fixturePolicy(box, { submitGate: 'landing', affectedTests: RUN });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), REPORTER);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed packet wording fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  assert.equal((await joinFixtureSeat(box, builder, 'web', { run: box.runIn })).code, 0);
  const added = JSON.parse((await ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1',
    '--criterion', '1. The page shows a greeting [test] 2. Legacy callers keep working [test] 3. Old browsers fall back to plain text [test]',
    '--check', `${RUN} web/packet.test.js`, '--json')).out);
  const id = added.item.item_id;
  await ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/packet.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('the page shows a greeting [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    "test('the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    "test('clause 3: Old browsers fall back to plain text [G1]', { skip: true }, () => assert.fail('not implemented'));",
    '',
  ].join('\n'));
  box.git(builder, 'add', '-A');
  box.git(builder, 'commit', '-q', '-m', 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  for (const n of [1, 2, 3]) await ok(box, builder, 'fact', String(id), 'note', `clause ${n} [test]: web/packet.test.js, run by the check for clause ${n}`);
  assert.equal((await settleSubmit(t, box, JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out))).gate.green, true, 'the fixture gate is green');

  const review = (await ok(box, box.repo, 'show', String(id), '--review')).out;
  assert.match(review, /^ {5}covered by the gate's item check \(receipt [0-9a-f]{8}\)/mu, 'clause 1: a clause the item check ran green reads covered');
  assert.match(review, /^ {5}no test maps to this clause: read the diff for it and name it in --read$/mu, 'clause 2: an unmapped clause says so');
  assert.doesNotMatch(review, /no recorded run: read this clause/u);

  const reviewer = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
  assert.equal((await joinFixtureSeat(box, reviewer, 'api', { run: box.runIn })).code, 0);
  await ok(box, reviewer, 'next', '--verify', String(id));
  const accepted = await ok(box, reviewer, 'verify', String(id), 'accept', '--read', '3', '--note', 'read the diff for clause 3; the skipped case is not claimed');
  assert.match(accepted.out, /accepted on the gate's green receipts and your reading of clause 3/u, 'clause 3: accept says what was read');
});
