/** @pullboard-test-input packages/store/src/io/board/next.js packages/store/src/io/eligibility.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { claim } from '../../index.js';
import { dispatchWork } from '../../index.js';
import { getItem } from '../../index.js';
import { heldClaim } from '../../index.js';
import { nextFor } from '../../index.js';
import { queueSubmitHandoff } from '../../index.js';
import { setItem } from '../../index.js';
import { setLineSetting } from '../../index.js';
import { fixture } from '../fixtures/dispatch.js';

/** Require both native selection paths to return the same item for the same board and seat. */
function assertSameSelection(board, seat) {
  const planned = nextFor(board, { agentId: seat.id, lane: seat.lane });
  const dispatched = dispatchWork(board, { agent_id: seat.id, agent_lane: seat.lane });
  assert.equal(dispatched.item?.item_id ?? null, planned.item?.item_id ?? null);
}

test('store.io-claim.interactive-and-automatic-selection-agree-with: interactive and automatic selection agree with no claim or a live claim [C7,#2899]', t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const open = box.add('One eligible item');
  assertSameSelection(box.board, seat);
  box.claim(open);
  assertSameSelection(box.board, seat);
});

test('store.io-claim.interactive-and-automatic-selection-ignore-a: interactive and automatic selection ignore a claim with a queued submit handoff [C7,#2899]', t => {
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
  // The queued claim is not a held claim on either path; the other item is merely waiting on it, as the fixture's file overlap says.
  assert.notEqual(nextFor(box.board, { agentId: seat.id, lane: seat.lane }).item?.item_id, queued);
  assert.ok(available > queued);
});

test('store.io-claim.interactive-and-automatic-selection-agree-on: interactive and automatic selection agree on an own rejected item [C7,#2899]', t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const rejected = box.add('Own rejected item');
  setLineSetting(box.board, { agentId: 'coordinator', key: 'returnRejectedWork', value: true,
    reason: 'exercise the shared own-rejection selection rule',
    window: { windowMinutes: 60, activeReviewers: 1, reviewMedianMinutes: null } });
  setItem(box.board, rejected, { item_verdict: 'REJECT', item_built_by: seat.id });
  assertSameSelection(box.board, seat);
});

test('store.io-claim.nextfor-and-dispatchwork-read-held-claims: nextFor and dispatchWork read held claims from the one heldClaim function, with no second claim filter [C7,#2899]', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['board/next.js', 'eligibility.js']) {
    const source = readFileSync(new URL(`../../src/io/${file}`, import.meta.url), 'utf8');
    assert.match(source, /heldClaim\(board, agentId/u, `${file} calls heldClaim`);
    assert.doesNotMatch(source, /item_status === 'claimed' && [a-z]+\.item_owner === agentId/u, `${file} keeps no claim filter of its own`);
  }
});

/** Claim as the builder seat into an item folder at claims.perSeat 1, as next and claim do on a board whose main sets 1. */
function claimAtOne(box, id) {
  return claim(box.board, id, { agentId: box.seats.builder.id, lane: box.seats.builder.lane, leaseMs: 3_600_000, itemFolder: true, perSeat: 1,
    freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } });
}

test('store.io-claim.child-of-unheld-parent-counts: clause 1: at claims.perSeat 1 a held child of an unheld parent fills the seat, and heldClaim hands it back [C7,#10846]', t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const parent = box.add('Umbrella item nobody holds');
  const [first, second] = ['First slice', 'Second slice'].map(title => box.add(title, { parentId: parent }));
  const top = box.add('A top-level item');
  claimAtOne(box, first);
  assert.throws(() => claimAtOne(box, second), error => error.code === 'ONE_CLAIM' && /#\d+.*up to 1/u.test(error.message),
    'a second slice of an unheld parent is refused at the cap');
  assert.throws(() => claimAtOne(box, top), error => error.code === 'ONE_CLAIM', 'a top-level item is refused beside the held slice');
  assert.equal(getItem(box.board, second).item_status, 'open');
  assert.equal(heldClaim(box.board, seat.id)?.item_id, first, 'next selection reads the held slice as the seat\'s claim');
  assert.equal(nextFor(box.board, { agentId: seat.id, lane: seat.lane }).item?.item_id, first, 'next hands the held slice back instead of another');
});

test('store.io-claim.child-of-own-parent-free: clause 2: a seat holding the parent still claims its children beside it [C7,#10846]', t => {
  const box = fixture(t);
  const seat = box.seats.builder;
  const parent = box.add('Parent this seat holds');
  const children = ['Child one', 'Child two'].map(title => box.add(title, { parentId: parent }));
  claimAtOne(box, parent);
  for (const child of children) claimAtOne(box, child);
  for (const id of [parent, ...children]) assert.equal(getItem(box.board, id).item_owner, seat.id, `#${id} is held by the seat`);
  assert.equal(heldClaim(box.board, seat.id)?.item_id, parent, 'the parent stays the seat\'s held claim');
});
