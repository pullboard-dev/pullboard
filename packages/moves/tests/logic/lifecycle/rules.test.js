/** The notBuilder rule lets a builder accept its own work only when every row is low-stakes and every check is machine-run red then green [C7,#11140]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULES } from '../../../index.js';
import { judge } from '../../../index.js';
import { newItem } from '../../../index.js';
import { unmetWaits } from '../../../src/logic/lifecycle/rules.js';

const frozenAs = (...stakes) => JSON.stringify({ rows: stakes.map((value, index) => ({ id: `R${index + 1}`, ...(value ? { stakes: value } : {}) })) });
const item = { ...newItem(1), status: 'submitted', builder: 'core-1', frozen: frozenAs('low') };
const rows = [{ id: 'R1', stakes: 'low', personApproved: true }];
const checks = [{ machineRun: true, redBefore: true, greenAfter: true }];
const holds = (snapshot, kind, by = 'core-1') => RULES.notBuilder.holds({ item, items: new Map(), ...snapshot }, { kind, by });

test('moves.lifecycle-rules.builder-self-accepts-low-stakes-machine-run: clause 1: the notBuilder precondition lets the builder reserve and accept its own submitted item when soloLowStakes is true, every row is low-stakes and person-approved and every check is machine-run red before and green after [C7,#11140]', () => {
  for (const kind of ['reserve', 'accept']) assert.equal(holds({ soloLowStakes: true, rows, checks }, kind), true, kind);
  assert.equal(holds({ soloLowStakes: true, rows, checks: [...checks, ...checks] }, 'accept'), true);
  assert.equal(holds({}, 'accept', 'core-2'), true, 'another agent was never refused');
});

test('moves.lifecycle-rules.self-verify-still-refused-otherwise: clause 2: SELF_VERIFY still refuses the builder when soloLowStakes is false or absent, a row is team, critical, unstaked or not person-approved, a check is not machine-run red and green, the lists are empty or absent, and always for reject and review-landed [C7,#11140]', () => {
  const on = { soloLowStakes: true, rows, checks };
  assert.equal(holds({ ...on, soloLowStakes: false }, 'accept'), false);
  assert.equal(holds({ rows, checks }, 'accept'), false);
  for (const stakes of ['team', 'critical', undefined]) assert.equal(holds({ ...on, rows: [{ id: 'R1', stakes, personApproved: true }] }, 'accept'), false, String(stakes));
  assert.equal(holds({ ...on, rows: [...rows, { id: 'R2', stakes: 'team', personApproved: true }] }, 'accept'), false);
  assert.equal(holds({ ...on, rows: [{ id: 'R1', stakes: 'low', personApproved: false }] }, 'accept'), false);
  assert.equal(holds({ ...on, rows: [{ id: 'R1', stakes: 'low' }] }, 'accept'), false);
  for (const field of ['machineRun', 'redBefore', 'greenAfter']) assert.equal(holds({ ...on, checks: [{ ...checks[0], [field]: false }] }, 'accept'), false, field);
  assert.equal(holds({ ...on, checks: [...checks, { machineRun: true, redBefore: true }] }, 'accept'), false);
  for (const empty of [{ rows: [] }, { checks: [] }, { rows: undefined }, { checks: undefined }]) assert.equal(holds({ ...on, ...empty }, 'accept'), false);
  for (const kind of ['reject', 'verify']) assert.equal(holds(on, kind), false, kind);
});

const claim = { soloLowStakes: true, checks, rows: [{ id: 'R1', stakes: 'low', personApproved: true }, { id: 'R2', stakes: 'low', personApproved: true }] };
const withFrozen = (frozen) => ({ ...item, frozen });
const verdict = (frozen, kind = 'accept') => judge(withFrozen(frozen), { kind, by: 'core-1', id: 9 }, new Map(), claim);

test('moves.lifecycle-rules.low-stakes-forged-refused: clause 1: the solo branch of notBuilder refuses LOW_STAKES_FORGED when a snapshot row says low for a row the item froze at team, critical or without stakes [C7,#11415]', () => {
  for (const frozen of [frozenAs('low', 'team'), frozenAs('low', 'critical'), frozenAs('low', undefined), frozenAs('critical', 'low'), frozenAs('low'), 'not json', undefined]) {
    for (const kind of ['reserve', 'accept']) {
      const answer = verdict(frozen, kind);
      assert.equal(answer.ok, false, `${kind} ${frozen}`);
      assert.equal(answer.code, 'LOW_STAKES_FORGED', `${kind} ${frozen}`);
    }
    assert.equal(RULES.notBuilder.holds({ ...claim, item: withFrozen(frozen) }, { kind: 'accept', by: 'core-1' }), false, String(frozen));
  }
  assert.equal(verdict(frozenAs('low', 'low')).code, undefined, 'a frozen low record admits it');
  assert.equal(judge(withFrozen(frozenAs('low', 'team')), { kind: 'accept', by: 'core-1', id: 9 }, new Map(), { ...claim, soloLowStakes: false }).code, 'SELF_VERIFY', 'with the setting off it is the plain refusal');
});

test('moves.lifecycle-rules.low-stakes-frozen-record-admits: clause 2: the solo branch admits the self-accept only when every snapshot row stakes equals the frozen record, and the refusal is the same from the relay as from the cli [C7,#11415]', async () => {
  const ok = { ...claim, item: withFrozen(frozenAs('low', 'low')) };
  for (const kind of ['reserve', 'accept']) assert.equal(RULES.notBuilder.holds(ok, { kind, by: 'core-1' }), true, kind);
  assert.equal(RULES.notBuilder.holds({ ...ok, item: withFrozen({ rows: [{ id: 'R1', stakes: 'low' }, { id: 'R2', stakes: 'low' }] }) }, { kind: 'accept', by: 'core-1' }), true, 'a parsed record reads like its text');
  assert.equal(RULES.notBuilder.holds({ ...ok, rows: ok.rows.slice(0, 1) }, { kind: 'accept', by: 'core-1' }), false, 'a frozen row left out is not low');
  assert.equal(RULES.notBuilder.holds({ ...ok, rows: [{ ...ok.rows[0], id: 'R9' }, ok.rows[1]] }, { kind: 'accept', by: 'core-1' }), false, 'a row the item never froze is not low');
  const { GUARD_RULES } = await import('../../../src/logic/table/item-moves.js');
  const bad = { ...claim, item: withFrozen(frozenAs('low', 'team')) };
  const relayed = { name: 'accept', actor: 'core-1', detail: { via: 'relay' } };
  const local = { name: 'accept', actor: 'core-1', detail: { via: 'cli' } };
  assert.equal(GUARD_RULES.notBuilder.holds(bad, relayed), false);
  assert.equal(GUARD_RULES.notBuilder.holds(bad, local), false);
  assert.equal(GUARD_RULES.notBuilder.holds(ok, relayed), true);
  assert.equal(GUARD_RULES.notBuilder.holds(ok, local), true);
});

const waiter = (extra = {}) => ({ ...newItem(2), after: [7], ...extra });
const parent = (extra = {}) => new Map([[7, { status: 'submitted', gateGreen: true, ...extra }]]);

test('moves.lifecycle-rules.after-gate-parent-satisfies-wait: clause 1: unmetWaits returns no unmet wait for an id in item.afterGate whose item is submitted with gateGreen true, so dependenciesVerified holds; the same parent submitted without gateGreen, or open, is still returned as unmet [C7,#11803]', () => {
  const gated = waiter({ afterGate: [7] });
  assert.deepEqual(unmetWaits(gated, parent()), []);
  assert.equal(RULES.dependenciesVerified.holds({ item: gated, items: parent() }, {}), true);
  assert.deepEqual(unmetWaits(gated, parent({ gateGreen: false })), [{ id: 7, state: 'submitted' }]);
  assert.deepEqual(unmetWaits(gated, parent({ gateGreen: undefined })), [{ id: 7, state: 'submitted' }]);
  assert.deepEqual(unmetWaits(gated, parent({ status: 'open' })), [{ id: 7, state: 'open' }]);
});

test('moves.lifecycle-rules.after-gate-only-for-listed-ids: clause 2: an id in item.after that is not in item.afterGate still needs status verified, even when that item is submitted with gateGreen true; with afterGate and gateGreen absent the result equals today\'s [C7,#11803]', () => {
  assert.deepEqual(unmetWaits(waiter({ afterGate: [8] }), parent()), [{ id: 7, state: 'submitted' }]);
  assert.deepEqual(unmetWaits(waiter(), parent()), [{ id: 7, state: 'submitted' }]);
  assert.deepEqual(unmetWaits(waiter({ afterGate: [7] }), new Map([[7, { status: 'submitted' }]])), [{ id: 7, state: 'submitted' }]);
  assert.deepEqual(unmetWaits(waiter(), new Map([[7, { status: 'verified' }]])), []);
  assert.deepEqual(unmetWaits(waiter(), new Map([[7, { status: 'withdrawn', merged: true }]])), [{ id: 7, state: 'withdrawn-landed' }]);
  assert.deepEqual(unmetWaits(waiter(), new Map()), [{ id: 7, state: 'missing' }]);
});
