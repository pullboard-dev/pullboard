/** Gate receipts keep each named case of a file the frozen criterion names, and the review packet lists them [C7,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  fixturePolicy,
  joinFixtureSeat,
} from '../../../../../tests/fixtures/testkit.js';
import { testOutcomeCollector } from '../../../../../../../packages/gate/index.js';
import { singleFileTapOutcomes } from '../../../../../../../packages/gate/src/io/tap.js';

const helpers = createE2eHelpers();
/**
 * A green submit starts detached board workers (the verification comparison among them) that can still be writing
 * the fixture. A synchronous rmSync retrying ENOTEMPTY for them blocked the main thread past the runner's 30 s
 * file-exit timeout, which killed this file with a live Socket handle; delete asynchronously within a 15 s budget
 * and leave a fixture a worker still holds to the temporary directory [C7].
 */
after(async () => {
  await Promise.all(helpers.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 75, retryDelay: 200 })
    .catch(() => { /* A detached worker still writing past the budget keeps its temporary fixture. */ })));
});

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

const CRITERION = '1. web/cases.test.js shows a greeting [test] 2. web/cases.test.js names the visitor by first name [test]';

test('clause 1 and clause 2: the real submit gate records every case name of a plain node --test check in its exact-head receipt, and show --review lists each named case [C7,V4]', { timeout: 240_000 }, () => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  // The fixture's own `node --test` must run its files, not see this runner's context and skip them.
  delete box.env.NODE_TEST_CONTEXT;
  fixturePolicy(box, { submitGate: 'landing', affectedTests: 'node --test' });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  commit(box, box.repo, 'chore: seed named case fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  assert.equal(joinFixtureSeat(box, builder, 'web').code, 0);
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Greet the visitor', criterion: CRITERION,
    check: 'node --test web/cases.test.js', args: ['--specs', 'G1'] }).item_id;
  ok(box, builder, 'claim', String(id));
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/cases.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    "test('clause 1: the page shows a greeting [G1]', () => assert.match(greet('Ada Lovelace'), /^Hello/u));",
    "test('clause 2: the visitor is named # by first name [G1]', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));",
    "test('an empty name still greets [G1]', () => assert.match(greet(''), /^Hello/u));",
    "test('a later locale case [G1]', { skip: true }, () => assert.fail('not yet'));",
    '',
  ].join('\n'));
  commit(box, builder, 'feat(web): greet the visitor by first name [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();
  for (const n of [1, 2]) ok(box, builder, 'fact', String(id), 'note', `clause ${n} [test]: web/cases.test.js case clause ${n}`);
  const submitted = JSON.parse(ok(box, builder, 'submit', String(id), '--no-next', '--json').out);
  assert.equal(submitted.gate.green, true, 'the fixture gate is green');

  // The exact-head receipts the gate wrote, read from its own store.
  const shown = JSON.parse(ok(box, box.repo, 'show', String(id), '--json').out);
  const receipts = shown.proofReceipts.map(row => JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'gate-receipts', `${row.id}.json`), 'utf8')));
  const criterion = receipts.find(receipt => receipt.proof?.submitPhase === 'criterion') ?? receipts[0];
  assert.equal(criterion.head, head, 'the receipt is for the exact head');
  const outcomes = (criterion.testOutcomes ?? []).map(({ file, name, passed, skipped }) => `${file} ${passed ? 'pass' : 'fail'}${skipped ? ' skip' : ''} ${name}`).sort();
  assert.deepEqual(outcomes, [
    'web/cases.test.js pass skip a later locale case [G1]',
    'web/cases.test.js pass an empty name still greets [G1]',
    'web/cases.test.js pass clause 1: the page shows a greeting [G1]',
    'web/cases.test.js pass clause 2: the visitor is named # by first name [G1]',
  ].sort(), `every case name with its outcome: ${JSON.stringify(criterion)}`);

  // Clause 2 of the bar: show --review lists each [test] clause's named case from that receipt, never a file-level row.
  const packet = JSON.parse(ok(box, box.repo, 'show', String(id), '--review', '--json').out);
  const [first, second] = packet.clauses;
  for (const [clause, name] of [[first, 'clause 1: the page shows a greeting [G1]'], [second, 'clause 2: the visitor is named # by first name [G1]']]) {
    assert.ok(clause.runs.length > 0, `clause ${clause.n} has recorded runs`);
    assert.ok(clause.runs.every(run => run.test !== null), `clause ${clause.n} has no file-level-only row: ${JSON.stringify(clause.runs)}`);
    assert.ok(clause.runs.some(run => run.test === name && run.result === 'pass' && run.receipt === criterion.id),
      `clause ${clause.n} names its case from the receipt: ${JSON.stringify(clause.runs)}`);
  }
  const review = ok(box, box.repo, 'show', String(id), '--review').out;
  assert.match(review, /^ {5}pass web\/cases\.test\.js "clause 1: the page shows a greeting \[G1\]"; receipt [a-f0-9]{8} /mu);
  assert.match(review, /^ {5}pass web\/cases\.test\.js "clause 2: the visitor is named # by first name \[G1\]"; receipt [a-f0-9]{8} /mu);
});

test('clause 1: a case defined in a shared fixture and run by two test files is kept for each file instead of dropping the run [C7]', () => {
  const root = '/private/repo';
  const collector = testOutcomeCollector(root);
  const event = (type, file, name) => ({ type, data: { file: `${root}/${file}`, name, details: { type: 'test' } } });
  collector.observe(event('test:pass', 'test/shared.fixture.js', 'clause 1: no worktree list ran [C7]'), `${root}/test/a.test.js`);
  collector.observe(event('test:pass', 'test/a.test.js', 'a only case'), `${root}/test/a.test.js`);
  collector.observe(event('test:pass', 'test/shared.fixture.js', 'clause 1: no worktree list ran [C7]'), 'test/b.test.js');
  collector.observe(event('test:fail', 'test/shared.fixture.js', 'a case only one file loads'), `${root}/test/b.test.js`);
  assert.deepEqual(collector.finish(true, 4), [
    { file: 'test/a.test.js', name: 'clause 1: no worktree list ran [C7]', passed: true, skipped: false },
    { file: 'test/a.test.js', name: 'a only case', passed: true, skipped: false },
    { file: 'test/b.test.js', name: 'clause 1: no worktree list ran [C7]', passed: true, skipped: false },
    { file: 'test/shared.fixture.js', name: 'a case only one file loads', passed: false, skipped: false },
  ]);
  const unowned = testOutcomeCollector(root);
  for (let run = 0; run < 2; run += 1) unowned.observe(event('test:pass', 'test/shared.fixture.js', 'same case'));
  assert.equal(unowned.finish(true, 2), null, 'without the running file a duplicate still fails closed');
});

test('clause 1: the gate reads a plain node --test check only when it runs one file and accounts for every case [C7]', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: clause 1: passes \\# hashed',
    'ok 1 - clause 1: passes \\# hashed',
    '  ---',
    '  duration_ms: 1.2',
    "  type: 'test'",
    '  ...',
    'not ok 2 - fails',
    '  ---',
    "  location: '/tmp/x/web/cases.test.js:3:1'",
    "  type: 'test'",
    "  failureType: 'testCodeFailure'",
    '  ...',
    'ok 3 - later # SKIP',
    '  ---',
    "  type: 'test'",
    '  ...',
    '1..3',
    '# tests 3',
    '# pass 1',
  ].join('\n');
  assert.deepEqual(singleFileTapOutcomes('node --test web/cases.test.js', tap), [
    { file: 'web/cases.test.js', name: 'clause 1: passes # hashed', passed: true, skipped: false },
    { file: 'web/cases.test.js', name: 'fails', passed: false, skipped: false },
    { file: 'web/cases.test.js', name: 'later', passed: true, skipped: true },
  ]);
  assert.equal(singleFileTapOutcomes('node --test web/cases.test.js web/other.test.js', tap), null, 'two files: a passing case has no file');
  assert.equal(singleFileTapOutcomes('node --test web/cases.test.js; echo ok', tap), null, 'only the exact check form is read');
  assert.equal(singleFileTapOutcomes('node --test web/cases.test.js', tap.replace('# tests 3', '# tests 4')), null, 'an unaccounted case leaves the run unread');
});
