/** add and edit catch the plain faults in a bar and name the fix, through the CLI, in-process by default [C7,V2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { lintBar } from '../../../../../packages/state/index.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { onBoard } from '../../fixtures/land/board.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const GOOD = '1. the handler returns the canonical result [test]';

/** A scratch project and a helper that runs add or edit and parses the JSON refusal, if any. */
function project(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const refusal = result => { assert.notEqual(result.code, 0, result.out + result.err); return JSON.parse(result.out).error; };
  const add = (title, criterion, ...more) => fixtureAdd(box.runIn, box.repo, 'web', title, '--criterion', criterion, ...more, '--json');
  const edit = (id, ...args) => box.runIn(box.repo, 'edit', String(id), ...args, '--json');
  return { box, refusal, add, edit };
}

test('cli.journeys-add-bar-lint.add-refuses-four-clauses-a-clause: clause 1: add refuses four clauses, a clause with no tag and a measurement with no number, each naming the fix [C7]', async t => {
  const { refusal, add } = project(t);
  const long = refusal((await add('Long', '1. a [test] 2. b [test] 3. c [command] 4. d [test]')));
  assert.equal(long.code, 'BAR_AMBIGUOUS');
  assert.match(long.message, /4 clauses and a bar holds at most 3/u);
  assert.match(long.next, /split it into items of at most 3 clauses/u);
  const untagged = refusal((await add('Untagged', '1. a [test] 2. the cart shows its total')));
  assert.equal(untagged.code, 'CLAUSE_EVIDENCE_REQUIRED');
  assert.match(untagged.message, /clause 2 has no evidence kind; end each numbered clause with exactly one \[test\|command\|screenshot\|measurement\|reasoning\]/u);
  const unmeasured = refusal((await add('Unmeasured', '1. the page loads quickly [measurement]')));
  assert.match(unmeasured.message, /clause 1 is a \[measurement\] with no number/u);
  assert.match(unmeasured.next, /put the number in clause 1/u);
  assert.equal((await add('Fine', '1. the page loads in under 200 ms [measurement] 2. it prints OK [command] 3. the case passes [test]')).code, 0);
});

test('cli.journeys-add-bar-lint.add-warns-on-and-and-on: clause 2: add warns on "and" and on vague words, and a check green on main is refused unless the author says why [V2]', async t => {
  const { box, refusal, add, edit } = project(t);
  const warned = (await add('Warned', '1. the page works properly and prints OK [test]'));
  assert.equal(warned.code, 0, warned.out + warned.err);
  const said = JSON.parse(warned.out).warnings.map(w => `[${w.code}] ${w.message}`).join('\n');
  assert.match(said, /\[BAR_TWO_FACTS\] clause 1 joins two facts with "and"/u);
  assert.match(said, /\[BAR_VAGUE_WORD\] clause 1 says "works"/u);
  assert.match(said, /\[BAR_VAGUE_WORD\] clause 1 says "properly"/u);
  assert.deepEqual(lintBar('1. it handles load and supports retries [test]').warnings.map(w => w.code).sort(), ['BAR_TWO_FACTS', 'BAR_VAGUE_WORD', 'BAR_VAGUE_WORD']);
  assert.deepEqual(lintBar('1. it is fast [test]').warnings.map(w => w.code), ['BAR_VAGUE_WORD']);

  const check = 'node --test web/handler.test.js';
  const first = JSON.parse((await add('Seeded', GOOD, '--check', check)).out).item.item_id;
  const main = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  onBoard(box, board => store.saveCheckBaseline(board, first, { command: check, main, result: 'green' }));
  const refused = refusal((await add('Again', GOOD, '--check', check)));
  assert.equal(refused.code, 'CRITERION_PROVES_NOTHING');
  assert.match(refused.message, new RegExp(`already passes on main ${main.slice(0, 12)} \\(seen on #${first}\\)`, 'u'));
  assert.match(refused.next, /--accept-green "why it stays"/u);
  assert.equal((await add('Kept', GOOD, '--check', check, '--accept-green', 'guards a regression')).code, 0);
  const other = JSON.parse((await add('Other', GOOD, '--check', 'node --test web/other.test.js')).out).item.item_id;
  assert.equal(refusal((await edit(other, '--check', check))).code, 'CRITERION_PROVES_NOTHING');
});

test('cli.journeys-add-bar-lint.edit-refuses-the-same-faults-through: clause 3: edit refuses the same faults through the real CLI and leaves the bar as it was [C7]', async t => {
  const { box, refusal, add, edit } = project(t);
  const id = JSON.parse((await add('Editable', GOOD)).out).item.item_id;
  const bad = refusal((await edit(id, '--criterion', '1. a [test] 2. no tag here')));
  assert.equal(bad.code, 'CLAUSE_EVIDENCE_REQUIRED');
  assert.match(bad.message, /clause 2 has no evidence kind; end each numbered clause with exactly one/u);
  const long = refusal((await edit(id, '--criterion', '1. a [test] 2. b [test] 3. c [test] 4. d [test]')));
  assert.match(long.next, /split it into items of at most 3 clauses/u);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_criterion), GOOD);
  const fine = (await edit(id, '--criterion', '1. it returns the total quickly enough in under 50 ms [measurement]'));
  assert.equal(fine.code, 0, fine.out + fine.err);
});
