/** Landing is its own item dimension, derived by the rules layer, with the legal status and landing pairs declared once in the backbone [M1,M4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKBONE_STATES } from '../../../index.js';
import { LANDINGS } from '../../../index.js';
import { LEGAL_LANDING } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { legalLanding } from '../../../index.js';

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
