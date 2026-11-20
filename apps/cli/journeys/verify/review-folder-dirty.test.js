/** With verify.reviewFolder on, a seat checkout at the submitted commit that holds a modified tracked file and an untracked file still records a verdict from the review folder [C7,#8932]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

/** Put the reviewFolder setting in the box's trunk policy (fixturePolicy commits it). */
function setReviewFolder(box, on) {
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixturePolicy(box, { verify: { ...config.verify, reviewFolder: on } });
}

/** A project with one submitted, green item and a reviewer seat checked out at main (not at the submitted commit), reading the policy at its trunk. */
async function submitted(t, { folderOn = false } = {}) {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  fixturePolicy(box, { submitGate: 'landing', affectedTests: RUN });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  writeFileSync(join(box.repo, 'web/outcome-reporter.js'), REPORTER);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed review folder fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  assert.equal((await joinFixtureSeat(box, builder, 'web', { run: box.runIn })).code, 0);
  const added = JSON.parse((await ok(box, box.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1',
    '--criterion', '1. The visitor is named [test]',
    '--check', `${RUN} web/folder.test.js`, '--json')).out);
  const id = added.item.item_id;
  await ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/folder.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('clause 1: the visitor is named [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    '',
  ].join('\n'));
  box.git(builder, 'add', '-A');
  box.git(builder, 'commit', '-q', '-m', 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  await ok(box, builder, 'fact', String(id), 'note', 'clause 1 [test]: web/folder.test.js, run by the check for clause 1');
  assert.equal((await settleSubmit(t, box, JSON.parse((await ok(box, builder, 'submit', String(id), '--no-next', '--json')).out))).gate.green, true, 'the fixture gate is green');
  if (folderOn) setReviewFolder(box, true);
  const reviewer = join(box.dir, 'api-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  assert.equal((await joinFixtureSeat(box, reviewer, 'api', { run: box.runIn })).code, 0);
  return { box, id, head, reviewer };
}

test('cli.journeys-verify-review-folder-dirty.first-review: clause 1: with verify.reviewFolder on and the seat at the submitted commit holding a modified tracked file and an untracked file, verify accept records the verdict from the review folder and leaves both seat files byte-identical [C7,#8932]', { timeout: 300000 }, async (t) => {
  const { box, id, head, reviewer } = await submitted(t, { folderOn: true });
  await ok(box, reviewer, 'next', '--verify', String(id));
  box.git(reviewer, 'switch', '-q', '--detach', head);
  const tracked = join(reviewer, 'web/greet.js');
  const loose = join(reviewer, 'notes-untracked.txt');
  writeFileSync(tracked, `${readFileSync(tracked, 'utf8')}// local edit\n`);
  writeFileSync(loose, 'scratch notes\n');
  const before = { tracked: readFileSync(tracked), loose: readFileSync(loose), head: box.git(reviewer, 'rev-parse', 'HEAD').trim(), status: box.git(reviewer, 'status', '--porcelain') };
  assert.match(before.status, /web\/greet\.js/u, 'clause 1: the seat holds a modified tracked file');
  assert.match(before.status, /notes-untracked\.txt/u, 'clause 1: the seat holds an untracked file');
  const verdict = await ok(box, reviewer, 'verify', String(id), 'accept', '--note', 'ran web/folder.test.js in the review folder: 1 pass');
  assert.match(verdict.out + verdict.err, /accept/iu, 'clause 1: the verdict is recorded');
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard-review-folders')), 'clause 1: the checks ran in a review folder');
  assert.deepEqual(readFileSync(tracked), before.tracked, 'clause 1: the modified tracked file is byte-identical');
  assert.deepEqual(readFileSync(loose), before.loose, 'clause 1: the untracked file is byte-identical');
  assert.deepEqual({ head: box.git(reviewer, 'rev-parse', 'HEAD').trim(), status: box.git(reviewer, 'status', '--porcelain') }, { head: before.head, status: before.status }, 'clause 1: the seat HEAD and status are unchanged');
});
