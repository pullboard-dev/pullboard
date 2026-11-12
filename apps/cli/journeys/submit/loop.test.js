/** Real native red handoffs stop unchanged resubmits until the item source or its facts advance [C7]. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Require authentic command success before reading its result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read one item's actual persisted handoff without mutating the board. */
function state(box, id) {
  // @pullboard-board-file journey: read the handoff state the real CLI persisted
  const board = openBoard(box.boardFile);
  try { return { item: store.getItem(board, id), job: store.submitHandoff(board, id), proofs: store.proofReceipts(board, id) }; }
  finally { board.db.close(); }
}

/** Wait for a detached worker to finish, then retain unexpected terminal errors in the assertion. */
async function waitJob(box, id, expected, previous = null, { head, snapshot } = {}) {
  const job = await box.helpers.waitFor(() => { // budget: detached worker completion ceiling, not a timing assertion.
    const job = state(box, id).job;
    return job && job.id !== previous && ['green', 'submitted', 'red', 'infrastructure', 'incomplete'].includes(job.state) ? job : null;
  }, `native terminal submit handoff`, 120000);
  let sourceAtCandidate = null;
  let sourceReadError = null;
  try { sourceAtCandidate = box.git(box.web, 'show', `${job.commit}:web/snapshot.txt`); }
  catch (error) { sourceReadError = error.message; }
  const receipts = state(box, id).proofs.map(receipt => {
    let output = '';
    try { if (receipt.logPath) output = fs.readFileSync(receipt.logPath, 'utf8').slice(-1800); }
    catch (error) { output = `<log unavailable: ${error.message}>`; }
    return { kind: receipt.kind, commit: receipt.commit, command: receipt.command, green: receipt.green,
      exitCode: receipt.exitCode, counts: receipt.counts, failures: receipt.failures, output };
  });
  const diagnostic = { expected, actual: job.state, expectedHead: head, job, sourceAtCandidate, sourceReadError, receipts };
  if (head) assert.equal(job.commit, head, `queued candidate matches the submitted web HEAD: ${JSON.stringify(diagnostic)}`);
  if (snapshot !== undefined) assert.equal(sourceAtCandidate, snapshot, `queued candidate contains the submitted source: ${JSON.stringify(diagnostic)}`);
  assert.equal(job.state, expected, `native submit handoff terminal proof: ${JSON.stringify(diagnostic)}`);
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
  t.after(async () => {
    const job = item === null ? null : state(box, item).job;
    if (job) await helpers.waitFor(() => !fs.existsSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', job.id, 'source')),
      'normal queued worker cleanup');
    helpers.cleanup();
  });
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  delete config.submitGate;
  delete config.submitDeferAbove;
  fs.writeFileSync(configFile, JSON.stringify({ ...config, gate: check, submit: { handoff: true },
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
  const firstRedHead = box.git(box.web, 'rev-parse', 'HEAD');
  document((await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json')));
  await waitJob(box, item, 'red', null, { head: firstRedHead, snapshot: 'red' });
  const firstRedJob = state(box, item).job.id;
  document((await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json')));
  await waitJob(box, item, 'red', firstRedJob, { head: firstRedHead, snapshot: 'red' });
  const secondRedJob = state(box, item).job.id;

  box.git(box.web, 'commit', '--allow-empty', '-q', '-m', 'chore: change only the commit message [G1]');
  const unchanged = (await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json'));
  assert.equal(unchanged.code, 1);
  const unchangedError = JSON.parse(unchanged.out).error;
  assert.equal(unchangedError.code, 'SUBMIT_RED_LOOP');
  assert.match(unchangedError.next, /two red test failures/u);
  assert.match(unchangedError.next, /red-loop-gate\.test\.cjs:source stays green/u);
  assert.equal(state(box, item).job.id, secondRedJob, 'a refusal queues no third gate');

  fs.writeFileSync(join(box.repo, 'docs-main-advance.md'), 'unrelated main change\n');
  box.git(box.repo, 'add', 'docs-main-advance.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance main without changing item code [G1]');
  box.git(box.web, 'merge', '--no-edit', 'main');
  const merged = (await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json'));
  assert.equal(merged.code, 1);
  assert.equal(JSON.parse(merged.out).error.code, 'SUBMIT_RED_LOOP', 'a pure main merge is not new item code evidence');
  assert.equal(state(box, item).job.id, secondRedJob, 'the main-only refusal queues no gate');

  document((await box.runLocal(box.web, 'fact', String(item), 'note', 'The repeated red test was observed on the unchanged source.', '--json')));
  const factRedHead = box.git(box.web, 'rev-parse', 'HEAD');
  document((await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json')));
  await waitJob(box, item, 'red', secondRedJob, { head: factRedHead, snapshot: 'red' });
  const thirdRedJob = state(box, item).job.id;

  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', 'green\n', 'fix(web): repair the red source [G1]').status, 0);
  const greenHead = box.git(box.web, 'rev-parse', 'HEAD');
  document((await box.runLocal(box.web, 'submit', String(item), '--no-next', '--json')));
  await waitJob(box, item, 'green', thirdRedJob, { head: greenHead, snapshot: 'green' });
  assert.equal(state(box, item).item.item_status, 'submitted');
});
