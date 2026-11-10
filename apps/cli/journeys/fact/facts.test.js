/** A clause fact citing an earlier head is shown beside the exact-head outcome on show --review, and submit names it before queuing [C7,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  fixturePolicy,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';
import {
  earlierHeadFacts,
  linkEarlierFacts,
  staleHeadLines,
} from '../../../../packages/state/index.js';

const helpers = createE2eHelpers();
/** Delete the fixtures asynchronously: a green submit leaves detached board workers that can still be writing them [C7]. */
after(async () => {
  await Promise.all(helpers.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 75, retryDelay: 200 })
    .catch(() => { /* A worker still writing past the budget keeps its temporary fixture. */ })));
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
const KEPT = 'clause 1: the page shows a greeting [G1]';
const RENAMED = 'clause 2: the visitor is named by first name [G1]';
const OLD = 'clause 2: the visitor is greeted by first name [G1]';

/** One fixture thread of note facts for the pure cases. */
function thread(...texts) {
  return texts.map((text, index) => ({ type: 'fact', kind: 'note', by: 'web-1', text, id: `fact${index}` }));
}

test('clause 1: a fact at an earlier head is listed, one at the exact head or at no head is not [C7]', () => {
  const item = { item_id: 5, item_owner: 'web-1', item_criterion: '1. a greeting shows [test] 2. a name shows [test]' };
  const head = 'b'.repeat(40);
  const facts = earlierHeadFacts(item, thread('clause 1 [test]: "a greeting case passes" passed at aaaaaaaaaa', 'clause 2 [test]: "a name case passes" passed at bbbbbbbbbb'), head);
  assert.deepEqual(facts.map(row => [row.clause, row.cited, row.cases]), [[1, 'aaaaaaaaaa', ['a greeting case passes']]]);
  assert.deepEqual(earlierHeadFacts(item, thread('clause 1 [test]: green run at aaaaaaaaaa', 'clause 1 [test]: green run at bbbbbbbbbb'), head), [], 'a clause with current evidence is not listed for the builder');
  assert.deepEqual(earlierHeadFacts(item, thread('clause 1 [test]: green run at aaaaaaaaaa', 'clause 1 [test]: green run at bbbbbbbbbb'), head, { everyEarlier: true }).map(row => row.cited), ['aaaaaaaaaa'], 'a reviewer still sees the earlier-head fact beside a current one');
  assert.deepEqual(earlierHeadFacts(item, thread('clause 1 [test]: green run with no head'), head), []);
  const linked = linkEarlierFacts(facts, [{ file: 'f.test.js', test: 'a greeting case passes', result: 'pass' }], []);
  assert.equal(linked[0].stale, false);
  assert.equal(linkEarlierFacts(facts, [], [])[0].stale, true, 'a named case the exact-head receipt lacks is stale');
  assert.match(staleHeadLines(item, thread('clause 1 [test]: "x" at aaaaaaaaaa'), head)[0], /^clause 1: its only evidence cites an earlier head \(aaaaaaaaaa\)/u);
});

test('clause 1: show --review links an earlier-head fact to the exact-head receipt outcome and names a missing case stale; clause 2: submit names those clauses before queuing [C7,V4]', { timeout: 300_000 }, () => {
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  fixturePolicy(box, { submitGate: 'landing', affectedTests: 'node --test' });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'));
  writeFileSync(join(box.repo, 'web/greet.js'), "export const greet = () => '';\n");
  commit(box, box.repo, 'chore: seed earlier-head fixture [G1]');
  const builder = join(box.dir, 'web-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
  assert.equal(joinFixtureSeat(box, builder, 'web').code, 0);
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Greet the visitor', criterion: CRITERION,
    check: 'node --test web/cases.test.js', args: ['--specs', 'G1'] }).item_id;
  ok(box, builder, 'claim', String(id));
  const cases = name2 => [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.js';",
    `test('${KEPT}', () => assert.match(greet('Ada Lovelace'), /^Hello/u));`,
    `test('${name2}', () => assert.equal(greet('Ada Lovelace'), 'Hello, Ada'));`,
    '',
  ].join('\n');
  writeFileSync(join(builder, 'web/greet.js'), "export const greet = (name) => `Hello, ${name.split(' ')[0]}`;\n");
  writeFileSync(join(builder, 'web/cases.test.js'), cases(OLD));
  commit(box, builder, 'feat(web): greet the visitor [G1]');
  const first = box.git(builder, 'rev-parse', '--short=10', 'HEAD').trim();
  ok(box, builder, 'fact', String(id), 'note', `clause 1 [test]: web/cases.test.js case "${KEPT}" passed at ${first}`);
  ok(box, builder, 'fact', String(id), 'note', `clause 2 [test]: web/cases.test.js case "${OLD}" passed at ${first}`);
  // A later commit renames clause 2's case, so the exact-head receipt no longer holds the case the fact names.
  writeFileSync(join(builder, 'web/cases.test.js'), cases(RENAMED));
  commit(box, builder, 'test(web): rename the clause 2 case [G1]');
  const head = box.git(builder, 'rev-parse', 'HEAD').trim();

  const submitted = ok(box, builder, 'submit', String(id), '--no-next');
  const said = `${submitted.out}\n${submitted.err}`;
  for (const n of [1, 2]) assert.match(said, new RegExp(`clause ${n}: its only evidence cites an earlier head \\(${first}\\)`, 'u'), `submit names clause ${n} before queuing: ${said}`);
  assert.ok(said.indexOf('only evidence cites an earlier head') < said.search(/queued|gate/iu) || /queued/iu.test(said), 'the notice comes with the submit output');

  const packet = JSON.parse(ok(box, box.repo, 'show', String(id), '--review', '--json').out);
  assert.equal(packet.head, head);
  const [one, two] = packet.clauses;
  assert.equal(one.earlier[0].stale, false, 'clause 1: the case still runs at the exact head');
  assert.deepEqual(one.earlier[0].outcomes.map(row => [row.name, row.outcome]), [[KEPT, 'pass']]);
  assert.equal(two.earlier[0].stale, true, 'clause 2: the old case is missing at the exact head');
  assert.deepEqual(two.earlier[0].outcomes.map(row => [row.name, row.outcome]), [[OLD, 'missing']]);
  assert.deepEqual(packet.staleClauses, [2]);
  const text = ok(box, box.repo, 'show', String(id), '--review').out;
  assert.match(text, /earlier head: fact \w+ cites \w+; at the exact head \w+: pass "clause 1:/u);
  assert.match(text, /stale: fact \w+ cites \w+; .*missing "clause 2:.*clause 2 is stale/u);
});
