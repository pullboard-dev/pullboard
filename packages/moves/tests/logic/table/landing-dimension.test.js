/** Landing is its own item dimension, derived by the rules layer, with the legal status and landing pairs declared once in the backbone [M1,M4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKBONE_STATES } from '../../../index.js';
import { LANDINGS } from '../../../index.js';
import { LEGAL_LANDING } from '../../../index.js';
import { landingEngine } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { legalLanding } from '../../../index.js';
import { runTable } from '../../../index.js';

test('moves.landing-dimension.the-rules-layer-derives-landing-none-for: clause 1: the rules layer derives landing none for an item without a landing receipt and landed for an item with one [M1,M4]', () => {
  assert.deepEqual(LANDINGS, ['none', 'landed', 'pulling', 'published']);
  assert.equal(landingOf({ status: 'verified', mergedCommit: null }), 'none');
  assert.equal(landingOf({ status: 'verified' }), 'none');
  assert.equal(landingOf({ status: 'verified', merged: false }), 'none');
  assert.equal(landingOf(null), 'none');
  assert.equal(landingOf({ status: 'verified', mergedCommit: 'abc123' }), 'landed');
  assert.equal(landingOf({ status: 'withdrawn', mergedCommit: 'abc123' }), 'landed', 'a forced hand landing is landed too');
  assert.equal(landingOf({ status: 'verified', merged: true }), 'landed', 'the backbone snapshot spells the receipt as merged');
});

test('moves.landing-dimension.the-backbone-exports-the-legal-status-and: clause 2: the backbone exports the legal status and landing pairs, holding every pair today\'s tables reach, withdrawn with landed included [M1,M4]', () => {
  const statuses = BACKBONE_STATES.filter(state => Object.hasOwn(LEGAL_LANDING, state));
  assert.deepEqual(Object.keys(LEGAL_LANDING).sort(), ['claimed', 'open', 'submitted', 'verified', 'withdrawn'], 'one entry per stored status');
  assert.deepEqual(statuses.sort(), Object.keys(LEGAL_LANDING).sort());
  for (const status of statuses) for (const landing of LEGAL_LANDING[status]) assert.ok(LANDINGS.includes(landing), `${status}/${landing}`);
  // Today: every status unlanded, verified work landed by the lander, and withdrawn work landed by a forced hand merge.
  for (const [status, landing] of [['open', 'none'], ['claimed', 'none'], ['submitted', 'none'], ['verified', 'none'], ['verified', 'landed'], ['withdrawn', 'none'], ['withdrawn', 'landed']]) {
    assert.equal(legalLanding(status, landing), true, `${status}/${landing}`);
  }
  for (const [status, landing] of [['open', 'landed'], ['claimed', 'landed'], ['submitted', 'published'], ['verified', 'pulling'], ['verified', 'merged'], ['lost', 'none']]) {
    assert.equal(legalLanding(status, landing), false, `${status}/${landing}`);
  }
});

const ENGINE = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY', 'LAND_RUNNER_FAULT'], repeatHold: 'landing-repeat-test:' });

/** A verified dependent at its reviewed commit whose after list holds one after-gate parent in the given state. */
function dependentSelect(parent) {
  const item = { id: 60, status: 'verified', mergedCommit: null, holdReason: null, commit: 'c1', checked: 'c1', after: [61] };
  const snapshot = { now: '2026-11-15T12:00:00.000Z', base: 'b1', item, items: { 60: item, 61: { id: 61, ...parent } }, batches: [], waivers: [], unverified: [], picked: { count: 0, touched: {} }, collisionFree: false, io: {} };
  return runTable(ENGINE.tables.select, ENGINE.rules, snapshot, { name: 'select', id: 60 });
}

test('moves.landing-dimension.dependent-waits-for-after-gate-parent: clause 1: a verified dependent whose after-gate parent is verified but not merged is refused WAITS_ON_ITEM and is selected once the parent has a merged commit [C7,#11806]', () => {
  const waiting = dependentSelect({ status: 'verified', mergedCommit: null });
  assert.equal(waiting.refused?.code, 'WAITS_ON_ITEM');
  const landed = dependentSelect({ status: 'verified', mergedCommit: 'm1' });
  assert.equal(landed.refused, undefined);
  assert.equal(landed.events[0].detail.id, 60);
});
