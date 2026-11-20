/** @pullboard-test-input source-cell packages/api */
/** A pulled gate receipt's static known-main rows become known main red facts on the item at the job's pinned main [C7,#10567]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

const ROWS = [{ rule: 'rule-a', file: 'packages/a/x.js' }, { rule: 'rule-b', file: 'packages/b/y.js' }];

/**
 * A claimed item whose pulled gate job is claimed by a runner, the receipt posted through boardJobQueueCall, the call the board runs for a runner's receipt.
 * `newer` offers a second gate job for the item before the post, so the first job's receipt reads as stale.
 */
function postedGate(t, { analysis, newer = false }) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const request = { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } };
  const job = `gate:${item.item_id}:known-main`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1, request });
  const lease = claimJob(board.db, { runner: 'r-known-main', capabilities: [], now: 2 });
  if (newer) offerJob(board.db, { id: `${job}-newer`, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 3, request });
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-known-main', token: lease.token,
    receipt: { version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] }, ...(analysis === undefined ? {} : { analysis }) } }, { mode: 'pull', now: 4 });
  const facts = store.itemThread(board, item.item_id).map(fact => fact.text ?? '').filter(text => text.includes('also red on main'));
  return { posted, facts, head };
}

test('api.gate-known-main-static.rows-become-known-main-facts: clause 1: a fresh receipt whose analysis has staticKnownMain rows records one known main red fact per row at the offered job\'s main, through the receipt call a runner posts [C7,#10567]', t => {
  const { posted, facts, head } = postedGate(t, { analysis: { staticKnownMain: ROWS } });
  assert.equal(posted.applied.outcome, 'review');
  assert.equal(facts.length, 2, 'one fact per row');
  for (const [index, row] of ROWS.entries()) {
    assert.ok(facts[index].includes(row.file) && facts[index].includes(row.rule), `the fact names ${row.file} and ${row.rule}`);
    assert.ok(facts[index].includes(`also red on main ${head.slice(0, 12)}`), 'the fact names the offered main');
  }
});

test('api.gate-known-main-static.nothing-recorded-without-rows-or-when-stale: clause 2: nothing is recorded when staticKnownMain is empty, absent, or the receipt is stale [C7,#10567]', t => {
  assert.deepEqual(postedGate(t, { analysis: { staticKnownMain: [] } }).facts, []);
  assert.deepEqual(postedGate(t, { analysis: {} }).facts, []);
  assert.deepEqual(postedGate(t, {}).facts, []);
  const stale = postedGate(t, { analysis: { staticKnownMain: ROWS }, newer: true });
  assert.equal(stale.posted.applied.outcome, 'stale');
  assert.deepEqual(stale.facts, []);
});
