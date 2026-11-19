/** A verdict projector given a derived reader answers from it, and computes only what the reader leaves undefined [C7,#8945]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verdictProjector } from '../../../../src/io/verdict/freshness.js';

const ROOT = '/nonexistent/no-git-here';
const item = { item_id: 7, item_status: 'verified', item_merged_commit: 'a'.repeat(40) };

/** A projector over a root with no Git, counting how often the computation reads the event log. */
function projector(derived) {
  const calls = { events: 0, accepted: 0 };
  const options = { events: () => { calls.events += 1; return []; }, acceptedVerdict: () => { calls.accepted += 1; return null; }, verdictReviewProblem: () => null, ...(derived ? { derived } : {}) };
  return { calls, projector: verdictProjector(ROOT, {}, { main: 'b'.repeat(40) }, options) };
}

test('verify.freshness.derived-reader: clause 1: a projector with a derived reader returns the reader state for an answered item, null included, with no Git read [C7,#8945]', () => {
  const stale = { code: 'STALE_VERDICT', reason: 'main moved', main: 'b'.repeat(40) };
  const answered = projector(() => stale);
  assert.deepEqual(answered.projector.state(item), stale);
  const fresh = projector(() => null);
  assert.equal(fresh.projector.state(item), null);
  for (const { calls } of [answered, fresh]) assert.deepEqual(calls, { events: 0, accepted: 0 }, 'the computation never ran');
});

test('verify.freshness.derived-fallback: clause 2: an item the reader answers undefined for is computed as before, and a projector without a reader behaves as today [C7,#8945]', () => {
  const unanswered = projector(() => undefined);
  assert.equal(unanswered.projector.state(item), null);
  assert.deepEqual(unanswered.calls, { events: 1, accepted: 1 }, 'the computation ran');
  const plain = projector();
  assert.equal(plain.projector.state(item), null);
  assert.deepEqual(plain.calls, { events: 1, accepted: 1 });
  assert.equal(plain.projector.state({ ...item, item_status: 'open' }), null);
});
