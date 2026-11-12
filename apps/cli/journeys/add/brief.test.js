/** An add with no route and no brief is strong unless its check names a test file, which fills a mid brief [V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Add one item to a scratch project with no route and no brief, and read back its route and brief. */
async function addWith(t, check) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Default route brief fixture';
  isolated.env.PULLBOARD_FIXTURE_ROUTES = 'board';
  const box = helpers.project('true', isolated);
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Small correction', '--criterion', 'the handler returns the canonical result [test]', '--check', check, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  return onBoard(box, board => store.getItem(board, id));
}

test('clause 1: add with no route, no brief and a check naming no test file succeeds on the strong route [V4]', async t => {
  const item = await addWith(t, 'npm test');
  assert.equal(item.item_route, 'strong');
});

test('clause 2: add with no route whose check names a test file lands mid with Files and Test filled from the check [V4]', async t => {
  const item = await addWith(t, 'node --test web/handler.test.js');
  assert.equal(item.item_route, 'mid');
  assert.match(item.item_brief, /Files:\s*\n- web\/handler\.test\.js/u);
  assert.match(item.item_brief, /Test: web\/handler\.test\.js/u);
});

/** Run the real CLI and require its successful versioned JSON result. */
async function json(box, ...args) {
  const result = await box.runLocal(box.repo, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('add accepts one cell, refuses three cells and records an explicit size override [B35,C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const one = (await json(box, 'add', 'web', 'Small', '--specs', 'G1', '--criterion', 'Update packages/alpha/a.js and packages/alpha/b.js.')).item;
  assert.equal(one.item_title, 'Small');
  const criterion = 'Update packages/alpha/a.js, packages/beta/b.js and packages/gamma/c.js.';
  const refusal = await fixtureAdd(box.runLocal, box.repo, 'web', 'Large', '--specs', 'G1', '--criterion', criterion, '--json');
  assert.notEqual(refusal.code, 0);
  const error = JSON.parse(refusal.out).error;
  assert.equal(error.code, 'ITEM_TOO_LARGE');
  assert.match(error.next, /one item per named cell.*alpha, beta, gamma/u);
  const forced = (await json(box, 'add', 'web', 'Explicit scope', '--specs', 'G1', '--criterion', criterion, '--force-size', 'one compatibility transaction')).item;
  const shown = await json(box, 'show', String(forced.item_id));
  const note = shown.thread.find(entry => entry.type === 'fact' && entry.text?.startsWith('Criterion size override:'));
  assert.ok(note, 'override must be a native item fact');
  assert.match(note.text, /one compatibility transaction/u);
  assert.match(note.text, /"cells":\["alpha","beta","gamma"\]/u);
  const blank = await fixtureAdd(box.runLocal, box.repo, 'web', 'Blank override', '--specs', 'G1', '--criterion', criterion, '--force-size', ' ', '--json');
  assert.equal(JSON.parse(blank.out).error.code, 'ITEM_SIZE_REASON');
});

test('add accepts three numbered clauses and refuses a fourth even inside one cell [B35,C7]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const criterion = '(1) Read packages/alpha/a.js. (2) Change it. (3) Prove it.';
  await json(box, 'add', 'web', 'Three clauses', '--specs', 'G1', '--criterion', criterion);
  const refused = await fixtureAdd(box.runLocal, box.repo, 'web', 'Four clauses', '--specs', 'G1', '--criterion', criterion + ' (4) Also publish it.', '--json');
  assert.equal(JSON.parse(refused.out).error.code, 'ITEM_TOO_LARGE');
  assert.match(JSON.parse(refused.out).error.next, /at most three numbered clauses/u);
});

test('add and edit refuse a check that runs pullboard test and accept the run-tests form [C7,#6188]', async t => {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  mkdirSync(join(box.repo, 'packages/gate/src/io/run'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/gate/src/io/run/tests.js'), '');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: run-tests launcher');
  const bad = 'node apps/cli/pullboard.js test web/handler.test.js';
  const good = 'node packages/gate/src/io/run/tests.js web/handler.test.js';
  const criterion = 'the handler returns the canonical result [test]';
  const refused = await fixtureAdd(box.runLocal, box.repo, 'web', 'Pull check', '--criterion', criterion, '--check', bad, '--json');
  assert.notEqual(refused.code, 0);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RUNS_PULLBOARD_TEST');
  assert.match(error.next, /node packages\/gate\/src\/io\/run\/tests\.js <files>/u);
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Run-tests check', '--criterion', criterion, '--check', good, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = String(JSON.parse(added.out).item.item_id);
  const edited = await box.runLocal(box.repo, 'edit', id, '--check', bad, '--json');
  assert.notEqual(edited.code, 0);
  const editError = JSON.parse(edited.out).error;
  assert.equal(editError.code, 'CHECK_RUNS_PULLBOARD_TEST');
  assert.match(editError.next, /node packages\/gate\/src\/io\/run\/tests\.js <files>/u);
});
