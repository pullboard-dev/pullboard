/** Real native red handoffs stop unchanged resubmits until the item source or its facts advance [C7]. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

/** Require authentic command success before reading its result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read one item's persisted row without mutating the board. */
function state(box, id) {
  // @pullboard-board-file journey: read the item state the real CLI persisted
  const board = openBoard(box.boardFile);
  try { return { item: store.getItem(board, id) }; }
  finally { board.db.close(); }
}

/** The item's newest gate job as `show --json` prints it (id, step, receipt gate). */
async function gateJobOf(box, id) {
  const shown = await box.runLocal(box.web, 'show', String(id), '--json', '--no-next');
  return document(shown).gateJob;
}

/** Submit, settle the pulled gate, and assert its verdict; returns the new gate job's id. */
async function submitSettled(t, box, id, expected, previous = null) {
  const submitted = await settleSubmit(t, box, document(await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json')));
  const job = submitted.gateJob;
  assert.notEqual(job.id, previous, 'the submit queued a new gate job');
  assert.equal(submitted.gate?.green === true ? 'green' : 'red', expected, `pulled gate verdict: ${JSON.stringify(job)}`);
  return job.id;
}

test('default clause inspection notes do not reset two red handoffs; later code or a new fact permits progress [C7]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  delete isolated.env.NODE_TEST_CONTEXT;
  const check = 'node --test web/red-loop-gate.test.cjs';
  let box;
  try { box = { ...helpers.project('true', isolated), helpers }; }
  catch (error) { helpers.cleanup(); throw error; }
  let item = null;
  t.after(() => helpers.cleanup());
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  delete config.submitGate;
  delete config.submitDeferAbove;
  fs.writeFileSync(configFile, JSON.stringify({ ...config, gate: check,
    verify: { policy: 'any', family: 'off', reviewRatio: 3, inspectClauses: true } }, null, 2) + '\n');
  fs.mkdirSync(join(box.repo, 'web'), { recursive: true });
  fs.writeFileSync(join(box.repo, 'web/red-loop-gate.test.cjs'), [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const test = require('node:test');",
    "test('source stays green (clause 1 and clause 2)', () => assert.notEqual(fs.readFileSync('web/snapshot.txt', 'utf8').trim(), 'red'));",
    '',
  ].join('\n'));
  fs.mkdirSync(join(box.repo, 'web'), { recursive: true });
  fs.writeFileSync(join(box.repo, 'web/snapshot.txt'), 'base\n');
  box.git(box.repo, 'add', 'pullboard.json', 'web/red-loop-gate.test.cjs', 'web/snapshot.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare red loop fixture [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = document((await fixtureAdd(box.runLocal, box.repo, 'web', 'Bound repeated red submissions', '--specs', 'G1',
    '--criterion', 'The source is correct when:\n1. the red input fails the test [test]\n2. the corrected input passes the test [test]',
    '--check', check, '--wait', '--json')));
  item = added.item.item_id;
  assert.equal(added.item.item_check, check, 'the frozen check executes the red-input test');
  document((await box.runLocal(box.web, 'claim', String(item), '--json')));
  document((await box.runLocal(box.web, 'fact', String(item), 'note', 'clause 1 [test]: web/red-loop-gate.test.cjs: source stays green (clause 1 and clause 2) observes the red input', '--json')));
  document((await box.runLocal(box.web, 'fact', String(item), 'note', 'clause 2 [test]: web/red-loop-gate.test.cjs: source stays green (clause 1 and clause 2) observes the corrected input', '--json')));
  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', 'red\n', 'feat(web): retain red source [G1]').status, 0);
  const firstRedJob = await submitSettled(t, box, item, 'red');
  const secondRedJob = await submitSettled(t, box, item, 'red', firstRedJob);

  box.git(box.web, 'commit', '--allow-empty', '-q', '-m', 'chore: change only the commit message [G1]');
  const unchanged = (await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json'));
  assert.equal(unchanged.code, 1);
  const unchangedError = JSON.parse(unchanged.out).error;
  assert.equal(unchangedError.code, 'SUBMIT_RED_LOOP');
  assert.match(unchangedError.next, /two red test failures/u);
  assert.match(unchangedError.next, /red-loop-gate\.test\.cjs:source stays green/u);
  assert.equal((await gateJobOf(box, item)).id, secondRedJob, 'a refusal queues no third gate');

  fs.writeFileSync(join(box.repo, 'docs-main-advance.md'), 'unrelated main change\n');
  box.git(box.repo, 'add', 'docs-main-advance.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance main without changing item code [G1]');
  box.git(box.web, 'merge', '--no-edit', 'main');
  const merged = (await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json'));
  assert.equal(merged.code, 1);
  assert.equal(JSON.parse(merged.out).error.code, 'SUBMIT_RED_LOOP', 'a pure main merge is not new item code evidence');
  assert.equal((await gateJobOf(box, item)).id, secondRedJob, 'the main-only refusal queues no gate');

  document((await box.runLocal(box.web, 'fact', String(item), 'note', 'The repeated red test was observed on the unchanged source.', '--json')));
  const thirdRedJob = await submitSettled(t, box, item, 'red', secondRedJob);

  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', 'green\n', 'fix(web): repair the red source [G1]').status, 0);
  await submitSettled(t, box, item, 'green', thirdRedJob);
  assert.equal(state(box, item).item.item_status, 'submitted');
});
