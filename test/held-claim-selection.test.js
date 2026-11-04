import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { dispatchWork, getItem, queueSubmitHandoff, setItem, setLineSetting } from '../packages/store/index.js';
import { nextFor } from '../packages/store/src/shell/board-next-for.js';
import { fixture } from './next-take-fixture.js';

/** Require both native selection paths to return the same item for the same board and seat. */
function assertSameSelection(board, seat) {
  const planned = nextFor(board, { agentId: seat.id, lane: seat.lane });
  const dispatched = dispatchWork(board, { agent_id: seat.id, agent_lane: seat.lane });
  assert.equal(dispatched.item?.item_id ?? null, planned.item?.item_id ?? null);
}

test('interactive and automatic selection agree with no claim or a live claim [C7,#2899]', async t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const open = box.add('One eligible item');
  assertSameSelection(box.board, seat);
  box.claim(open);
  assertSameSelection(box.board, seat);
});

test('interactive and automatic selection ignore a claim with a queued submit handoff [C7,#2899]', async t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const queued = box.add('Claim with a queued gate');
  const available = box.add('Next eligible item');
  box.claim(queued);
  const item = getItem(box.board, queued);
  const commit = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(seat.path, 'rev-parse', `${commit}^{tree}`);
  queueSubmitHandoff(box.board, queued, { job: randomUUID(), agentId: seat.id, commit, tree,
    main: box.git(box.root, 'rev-parse', 'HEAD'), executionCommit: commit, executionTree: tree,
    digest: item.item_frozen_digest, companionDigest: null, leaseMs: 60_000 });
  assertSameSelection(box.board, seat);
  assert.equal(nextFor(box.board, { agentId: seat.id, lane: seat.lane }).item.item_id, available);
});

test('interactive and automatic selection agree on an own rejected item [C7,#2899]', async t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const rejected = box.add('Own rejected item');
  setLineSetting(box.board, { agentId: 'coordinator', key: 'returnRejectedWork', value: true,
    reason: 'exercise the shared own-rejection selection rule',
    window: { windowMinutes: 60, activeReviewers: 1, reviewMedianMinutes: null } });
  setItem(box.board, rejected, { item_verdict: 'REJECT', item_built_by: seat.id });
  assertSameSelection(box.board, seat);
});
