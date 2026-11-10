/** A gate hand-off that ends 'submitted' with no green verdict sends its item back to the builder [C7,V4]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import { noVerdictHandoff } from '../../src/io/submit/handoff.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemsInStatus } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';

/** Require authentic command success before interpreting any native result. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Read the real SQLite state the worker and the sweep wrote, without writing anything. */
function state(box, id) {
  // @pullboard-board-file journey: observe the detached worker's and the sweep's persisted records.
  const board = openBoard(box.boardFile);
  try {
    return { item: getItem(board, id), job: submitHandoff(board, id),
      inReview: itemsInStatus(board, 'submitted').some(item => item.item_id === id),
      reopens: board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reopen'").all(id).map(row => JSON.parse(row.event_detail)),
      shouts: board.db.prepare('SELECT * FROM shout').all().filter(row => JSON.stringify(row).includes('HANDOFF_NO_VERDICT')) };
  } finally { board.db.close(); }
}

/**
 * End the finished hand-off as the live boards did (#2555, #3205, #3339): state 'submitted' with gateGreen false,
 * which a submit records when its proof was red only in cases that also fail on main.
 */
function endWithoutVerdict(box, id) {
  // @pullboard-board-file journey: rewrite only the fixture's job record to the observed no-verdict end state.
  const board = openBoard(box.boardFile);
  try {
    const job = submitHandoff(board, id);
    const ended = { ...job, state: 'submitted', gateGreen: false };
    // The gate job holds the record submitHandoff() reads (#3474, #3476).
    recordSubmitHandoff(board.db, id, ended);
  } finally { board.db.close(); }
}

/** Run one health sweep as the coordinator, from the main checkout; no command by the item's seat runs. */
function sweep(box) {
  const run = box.run(box.repo, 'sentinel', 'run', '--health-only');
  assert.equal(run.code, 0, `${run.err}\n${run.out}`);
}

test('clause 1: a hand-off that finishes with no verdict sends the item back [C7,V4]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, submit: { handoff: true } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure native submit handoff [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const id = document(fixtureAdd(box.run, box.repo, 'web', 'No-verdict handoff', '--route', 'strong', '--specs', 'G1',
    '--criterion', 'A hand-off with no verdict returns to its builder.', '--check', 'true', '--wait', '--json')).item.item_id;
  // The web bar may name only web-owned files (24e3f4c070).
  document(box.run(box.repo, 'fact', String(id), 'diagnosis',
    'Files: web/snapshot.txt Change: end a real hand-off with no verdict Test case: one sweep returns the item to its builder', '--json'));
  document(box.run(box.web, 'claim', String(id), '--json'));
  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', 'candidate\n', 'feat(web): no-verdict candidate [G1]').status, 0);
  assert.equal(document(box.run(box.web, 'submit', String(id), '--no-next', '--json')).queued, true);
  /** Whether the queued gate has finished and its item is submitted. */
  const finished = () => { const seen = state(box, id); return ['green', 'submitted'].includes(seen.job?.state) && seen.item.item_status === 'submitted'; };
  await helpers.waitFor(finished, 'the queued gate finishes and the item is submitted', 120000); // budget: worker completion ceiling, no timing assertion.
  const builder = state(box, id).item.item_built_by;
  endWithoutVerdict(box, id);
  const stranded = state(box, id);
  assert.equal(noVerdictHandoff(stranded.job, stranded.item), true, 'the fixture reproduces the live no-verdict end state');
  assert.equal(stranded.inReview, true, 'before the sweep the item sits in review with no packet');

  sweep(box);
  const after = state(box, id);
  assert.equal(after.item.item_status, 'open', 'the item left review');
  assert.equal(after.inReview, false, 'no reviewer is offered an item with no gate verdict');
  assert.equal(after.reopens.length, 1);
  assert.match(after.reopens[0].note, /^HANDOFF_NO_VERDICT: /u, 'the return names its reason');
  assert.ok(after.shouts.some(row => JSON.stringify(row).includes(builder)), 'the builder is told the item is back with it');
  assert.equal(noVerdictHandoff(after.job, after.item), false);

  sweep(box);
  assert.equal(state(box, id).reopens.length, 1, 'a second sweep returns nothing more');
});

test('a green hand-off and a submitted item at a newer head are never returned [C7,V4]', () => {
  const item = { item_status: 'submitted', item_commit: 'a'.repeat(40) };
  assert.equal(noVerdictHandoff({ state: 'green', gateGreen: true, submitted: item.item_commit }, item), false);
  assert.equal(noVerdictHandoff({ state: 'submitted', gateGreen: true, submitted: item.item_commit }, item), false);
  assert.equal(noVerdictHandoff({ state: 'submitted', gateGreen: false, submitted: 'b'.repeat(40) }, item), false);
  assert.equal(noVerdictHandoff({ state: 'submitted', gateGreen: false, submitted: item.item_commit }, { ...item, item_status: 'open' }), false);
  assert.equal(noVerdictHandoff({ state: 'submitted', gateGreen: false, submitted: item.item_commit }, item), true);
});
