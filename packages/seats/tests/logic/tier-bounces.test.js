/** @pullboard-test-input source-cell seats */
/** bouncesAtTier counts an item's bounces at its current tier since the last tier change [C7,#2178,#9841]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bouncesAtTier } from '../../index.js';

const pin = text => ({ type: 'fact', kind: 'note', text });
const move = kind => ({ type: 'move', kind, detail: {} });

test('seats.tier-bounces.count-at-tier: clause 1: bouncesAtTier counts the rejects and returned reviews routed at the tier [C7,#9841]', () => {
  const thread = [move('add'), move('claim'), move('submit'), move('reject'), move('claim'), move('submit'), move('reopen'), move('accept')];
  assert.equal(bouncesAtTier(thread, 'routine'), 2);
  assert.equal(bouncesAtTier(thread, 'escalation'), 0);
  assert.equal(bouncesAtTier([], 'routine'), 0);
  const pinned = [pin('tier-pin: standard'), move('reject'), move('reject'), pin('remember the milk')];
  assert.equal(bouncesAtTier(pinned, 'standard'), 2);
  assert.equal(bouncesAtTier(pinned, 'routine'), 0);
  assert.equal(bouncesAtTier(pinned, 'standard', { pin: 'standard' }), 2);
  assert.equal(bouncesAtTier(pinned, 'standard', { pin: 'routine' }), 0);
});

test('seats.tier-bounces.restart-on-pin-change: clause 2: the count restarts when the tier pin changes [C7,#9841]', () => {
  const thread = [move('reject'), move('reject'), pin('tier-pin: escalation'), move('reject'), move('reopen')];
  assert.equal(bouncesAtTier(thread, 'escalation'), 2);
  assert.equal(bouncesAtTier(thread, 'routine'), 0);
  assert.equal(bouncesAtTier([...thread, pin('tier-pin: escalation'), move('reject')], 'escalation'), 3, 'the same pin again is no change');
  assert.equal(bouncesAtTier([...thread, pin('tier-pin:'), move('reject')], 'routine'), 1, 'a cleared pin returns to routine with a fresh count');
});
