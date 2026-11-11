/** @pullboard-test-input source-tree */
/** A bounded stopgap leaves every unsent native usage revision available for later lifecycle moves [N2,C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { itemCost } from '../../../../../packages/stats/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const HISTORY = 10;
const LEASE = 2 * 60 * 60 * 1_000;

/** Seed closed native allocations on a fixture board without privately checkpointing their usage yet. */
function seedClosedClaims(box) {
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  let instant = Date.now() - 60_000;
  // @pullboard-board-file journey: the fixture's real CLI and direct setup share this named SQLite board.
  const board = openBoard(file, { now: () => new Date(instant) });
  const agent = store.agentAt(board, box.web).agent_id;
  const prior = [];
  const freeze = () => ({ text: '{}', digest: 'fixture-usage-cap' });
  /** Make the original check a genuine frozen red fixture gate, as in the native cost tests. */
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'web', title, specIds: ['G1'],
    criterion: 'usage allocation is retained', check: 'test -f web/ready',
    checkBaseline: { command: 'test -f web/ready', result: 'red', main, seconds: 0 } });
  try {
    for (let index = 0; index < HISTORY; index++) {
      const id = add(`Historical usage ${index + 1}`);
      prior.push(id);
      instant += 1_000;
      store.claim(board, id, { agentId: agent, lane: 'web', leaseMs: LEASE, freeze });
      instant += 1_000;
      store.release(board, id, agent, 'Close the private usage fixture claim.', 'OTHER');
    }
    return { file, agent, prior, target: add('Claim to resume usage') };
  } finally { store.closeBoard(board); }
}

/** Read only numeric item ids from the native board's sanitized usage events. */
function publishedItems(file, agent, prior) {
  // @pullboard-board-file journey: inspect the same CLI-written fixture board, not an in-memory substitute.
  const board = openBoard(file);
  try {
    return store.events(board).filter(event => event.event_kind === 'usage' && event.event_by === agent)
      .map(event => JSON.parse(event.event_detail).item).filter(item => prior.includes(item));
  } finally { store.closeBoard(board); }
}

test('ten missed revisions drain in one native claim under the 1000-revision bound without loss or duplication [N2,C7]', () => {
  const box = helpers.project('true');
  const { file, agent, prior, target } = seedClosedClaims(box);
  const first = box.run(box.web, 'claim', String(target));
  assert.equal(first.code, 0, first.err);
  assert.doesNotMatch(first.err, /USAGE_PENDING/, 'ten revisions sit far below USAGE_BATCH_LIMIT, so nothing remains pending');
  assert.deepEqual(publishedItems(file, agent, prior), prior);
  const second = box.run(box.web, 'claim', String(target));
  assert.equal(second.code, 0, second.err);
  assert.doesNotMatch(second.err, /USAGE_PENDING/);
  assert.deepEqual(publishedItems(file, agent, prior), prior);
  const fourth = box.run(box.web, 'claim', String(target));
  assert.equal(fourth.code, 0, fourth.err);
  assert.deepEqual(publishedItems(file, agent, prior), prior,
    'acknowledged revisions stay idempotent across another lifecycle move');
  // @pullboard-board-file journey: compare the fixture's final native numeric summaries with its ten one-second intervals.
  const board = openBoard(file);
  try {
    const totals = prior.map(id => itemCost(board, id));
    assert.deepEqual(totals.map(total => total.wallMs), Array(HISTORY).fill(1_000),
      'drained summaries equal publishing every closed one-second interval at once');
    assert.deepEqual(totals.map(total => total.knownInputTokens), Array(HISTORY).fill(0));
    assert.ok(totals.every(total => total.unknownReasons.includes('missed-claim-anchor')),
      'missing native attribution remains visibly unknown after the stopgap drains');
  } finally { store.closeBoard(board); }
});
