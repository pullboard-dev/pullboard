/** The notBuilder rule lets a builder accept its own work only when every row is low-stakes and every check is machine-run red then green [C7,#11140]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULES } from '../../../index.js';
import { newItem } from '../../../index.js';

const item = { ...newItem(1), status: 'submitted', builder: 'core-1' };
const rows = [{ stakes: 'low', personApproved: true }];
const checks = [{ machineRun: true, redBefore: true, greenAfter: true }];
const holds = (snapshot, kind, by = 'core-1') => RULES.notBuilder.holds({ item, items: new Map(), ...snapshot }, { kind, by });

test('moves.lifecycle-rules.builder-self-accepts-low-stakes-machine-run: clause 1: the notBuilder precondition lets the builder reserve and accept its own submitted item when soloLowStakes is true, every row is low-stakes and person-approved and every check is machine-run red before and green after [C7,#11140]', () => {
  for (const kind of ['reserve', 'accept']) assert.equal(holds({ soloLowStakes: true, rows, checks }, kind), true, kind);
  assert.equal(holds({ soloLowStakes: true, rows: [...rows, ...rows], checks: [...checks, ...checks] }, 'accept'), true);
  assert.equal(holds({}, 'accept', 'core-2'), true, 'another agent was never refused');
});

test('moves.lifecycle-rules.self-verify-still-refused-otherwise: clause 2: SELF_VERIFY still refuses the builder when soloLowStakes is false or absent, a row is team, critical, unstaked or not person-approved, a check is not machine-run red and green, the lists are empty or absent, and always for reject and review-landed [C7,#11140]', () => {
  const on = { soloLowStakes: true, rows, checks };
  assert.equal(holds({ ...on, soloLowStakes: false }, 'accept'), false);
  assert.equal(holds({ rows, checks }, 'accept'), false);
  for (const stakes of ['team', 'critical', undefined]) assert.equal(holds({ ...on, rows: [{ stakes, personApproved: true }] }, 'accept'), false, String(stakes));
  assert.equal(holds({ ...on, rows: [...rows, { stakes: 'team', personApproved: true }] }, 'accept'), false);
  assert.equal(holds({ ...on, rows: [{ stakes: 'low', personApproved: false }] }, 'accept'), false);
  assert.equal(holds({ ...on, rows: [{ stakes: 'low' }] }, 'accept'), false);
  for (const field of ['machineRun', 'redBefore', 'greenAfter']) assert.equal(holds({ ...on, checks: [{ ...checks[0], [field]: false }] }, 'accept'), false, field);
  assert.equal(holds({ ...on, checks: [...checks, { machineRun: true, redBefore: true }] }, 'accept'), false);
  for (const empty of [{ rows: [] }, { checks: [] }, { rows: undefined }, { checks: undefined }]) assert.equal(holds({ ...on, ...empty }, 'accept'), false);
  for (const kind of ['reject', 'verify']) assert.equal(holds(on, kind), false, kind);
});
