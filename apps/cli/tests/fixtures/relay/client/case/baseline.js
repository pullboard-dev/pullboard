/** Check the exact migrated baseline and its ordered receipt after a lost setup reply [H16,S1]. */
import assert from 'node:assert/strict';

/** Verify the local compatibility event before replay adds authenticated attribution. */
export function assertOriginalBaselineEvidence(event, baseline) {
  const detail = JSON.parse(event.event_detail);
  assert.deepEqual({ version: detail.version, file: detail.file, anchor: detail.anchor, rows: detail.rows }, baseline,
    'the original event records the exact accepted source rather than a later spec snapshot');
}

/** Keep the original event identity while checking the authenticated canonical replay and its ordering. */
export function assertBaselineResumeEvidence({ events, receipts, originalBaseline, originalBaselineEvent,
  authenticatedLogin, addedId, outboxRenumbered, addedItem }) {
  assert.equal(events.filter(event => event.event_kind === 'spec_approval_baseline').length, 1);
  const canonicalEvent = events.find(event => event.event_kind === 'spec_approval_baseline');
  assert.equal(canonicalEvent.event_id, originalBaselineEvent.event_id, 'resume preserves the original setup event identity');
  assert.equal(canonicalEvent.event_kind, originalBaselineEvent.event_kind);
  assert.equal(canonicalEvent.item_id, originalBaselineEvent.item_id);
  assert.equal(canonicalEvent.event_by, originalBaselineEvent.event_by);
  const detail = JSON.parse(canonicalEvent.event_detail);
  const originalDetail = JSON.parse(originalBaselineEvent.event_detail);
  assert.deepEqual({ version: detail.version, file: detail.file, anchor: detail.anchor, rows: detail.rows }, originalBaseline,
    'ordered replay preserves the exact version, file, anchor, and approved source rows');
  assert.equal(detail.model, originalDetail.model, 'ordered replay preserves the original event model');
  assert.equal(detail.person, authenticatedLogin, 'the ordered baseline event carries the authenticated GitHub person');

  const baselineReceipt = receipts.find(receipt => receipt.outcome.events?.some(event => event.event_id === originalBaselineEvent.event_id));
  assert.ok(baselineReceipt, 'the original baseline event is tied to its applied ordered receipt');
  assert.equal(JSON.parse(baselineReceipt.move).operation, 'recordSpecApprovalBaseline');
  assert.deepEqual(JSON.parse(baselineReceipt.move).args[0].baseline, originalBaseline,
    'the actual ordered move carries the accepted source snapshot');
  const receiptEvent = baselineReceipt.outcome.events.find(event => event.event_id === originalBaselineEvent.event_id);
  assert.ok(Number.isSafeInteger(baselineReceipt.sequence) && baselineReceipt.sequence > 0,
    'the baseline receipt has a positive relay sequence');
  assert.equal(canonicalEvent.event_at, receiptEvent.event_at, 'the replayed event time matches its ordered receipt');
  assert.deepEqual(canonicalEvent, receiptEvent, 'the local event is exactly the event recorded in its applied receipt');
  assert.ok(Number.isFinite(Date.parse(receiptEvent.event_at)), 'the ordered receipt carries a valid event time');

  const addReceipts = receipts.filter(receipt => JSON.parse(receipt.move).operation === 'addItem'
    && JSON.parse(receipt.move).args.some(value => value?.title === 'Work after migration'));
  assert.equal(addReceipts.length, 1, 'the relay keeps exactly one durable receipt for the recovered local add');
  const addReceipt = addReceipts[0];
  const addMove = JSON.parse(addReceipt.move);
  const renumbered = outboxRenumbered.filter(row => row.was === addedId);
  assert.ok(renumbered.length <= 1, 'the original local add has at most one canonical renumber mapping');
  const canonicalAddId = renumbered.length ? renumbered[0].is : addedId;
  assert.ok(Number.isSafeInteger(canonicalAddId), 'the original add resolves to a valid canonical item id');
  assert.ok(Number.isSafeInteger(addReceipt.outcome.result), 'the add receipt returns its canonical item id');
  assert.equal(addReceipt.outcome.result, canonicalAddId, 'the add result agrees with its explicit renumber mapping');
  assert.equal(addMove.args.find(value => value?.title === 'Work after migration').title, 'Work after migration',
    'the exact durable add receipt names the original requested title');
  const addReceiptEvents = (addReceipt.outcome.events ?? []).filter(event => event.event_kind === 'add' && event.item_id === canonicalAddId);
  assert.equal(addReceiptEvents.length, 1, 'the add receipt contains exactly one event for its canonical item');
  const canonicalAddEvents = events.filter(event => event.event_kind === 'add' && event.item_id === canonicalAddId);
  assert.equal(canonicalAddEvents.length, 1, 'replay retains the already completed canonical add exactly once');
  assert.deepEqual(canonicalAddEvents[0], addReceiptEvents[0], 'the canonical add event exactly matches its durable receipt');
  assert.equal(addedItem.item_id, canonicalAddId, 'the local item row uses the receipt-resolved canonical id');
  assert.equal(addedItem.item_title, 'Work after migration', 'the canonical item row retains the requested title');
  assert.ok(baselineReceipt.sequence < addReceipt.sequence, 'the accepted baseline remains ordered before the recovered add');
  assert.ok(Date.parse(receiptEvent.event_at) <= Date.parse(addReceipt.outcome.events[0].event_at),
    'the baseline receipt time precedes the later add receipt time');
}
