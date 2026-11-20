/** completeMoveHandoff hands a verify accept or reject review work only, and a submit no claim at all [C7,#11017,#12020]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeMoveHandoff } from '../../../src/logic/post/move.js';

const BUILD = { item: { item_id: 2, item_title: 'a build item' }, review: false, held: false, reasons: [] };
const REVIEW = { item: { item_id: 3, item_title: 'a review item' }, review: true, held: false, reasons: [] };

/** A hand-off run with an injected nextOnce that answers by whether it was asked for review work only. */
async function handoff({ reviewOnly, review, topUp, say = () => {} }) {
  const asked = [];
  const nextOnce = async (_ctx, options) => {
    asked.push(options);
    if (options.verify) return review ? REVIEW : { item: null, reasons: [] };
    return BUILD;
  };
  const ctx = { info: {}, io: { say, result() {} } };
  const services = { nextOnce, withBoardRead: () => [], listItems: () => [], agentSessionDigest: () => 'x', ...(topUp ? { topUp } : {}), ...(reviewOnly ? { reviewOnly: true } : {}) };
  // withBoardRead is called with a reader over a board; the fixture returns no omitted ids.
  const result = await completeMoveHandoff(ctx, 1, {}, { id: 1 }, services);
  return { result, asked };
}

test('verify.post-move.accept-never-claims-build: clause 1: a verify accept with a build item free and no review ready returns the idle result no eligible review work [C7,#11017]', async () => {
  const { result, asked } = await handoff({ reviewOnly: true, review: false });
  assert.equal(result.next.item, null);
  assert.deepEqual(result.next.reasons, ['no eligible review work']);
  assert.ok(asked.every(options => options.verify === true), 'every ask was for review work only');
});

test('verify.post-move.accept-still-reserves-review: clause 1: a verify accept with a review ready still reserves that review [C7,#11017]', async () => {
  const { result } = await handoff({ reviewOnly: true, review: true });
  assert.equal(result.next.item.item_id, 3);
  assert.equal(result.next.review, true);
});

test('verify.post-move.submit-never-claims: clause 1: a submit hand-off calls neither nextOnce for a build claim nor the topUp port, and the result names run pullboard next [C7,#12020]', async () => {
  let topUps = 0;
  const { result, asked } = await handoff({ reviewOnly: false, review: false, topUp: async () => { topUps += 1; return []; } });
  assert.deepEqual(asked, [], 'nextOnce was never called');
  assert.equal(topUps, 0, 'the topUp port was never called');
  assert.equal(result.next.item, null);
  assert.deepEqual(result.next.reasons, ['run pullboard next']);
});

test('verify.post-move.submit-keeps-lane: clause 2: after a submit the seat gets no claim or lane move, and a verify accept still reserves a ready review [C7,#12020]', async () => {
  const said = [];
  const submit = await handoff({ reviewOnly: false, review: true, say: line => said.push(line) });
  assert.equal(submit.result.next.item, null, 'a ready review is not reserved by a submit');
  assert.equal(submit.result.next.review, false);
  assert.deepEqual(said, ['next: run pullboard next']);
  const accept = await handoff({ reviewOnly: true, review: true });
  assert.equal(accept.result.next.item.item_id, 3);
  assert.equal(accept.result.next.review, true);
});
