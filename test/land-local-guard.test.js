/** Synthetic private unit inputs exercise attribution policy; these are not operational evidence or board receipts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireLocalGuardClassification } from '../src/land-local-guard.js';
import { NATIVE_FLAKE_ENGINE } from '../src/flake-engine.js';

/** Supply private in-memory ledger inputs without writing operational observations or receipts. */
function fixture(classification, green) {
  const failure = { file: 'test/private.test.js', name: 'private behavior' };
  const observation = { ...failure, id: 'private-unit', main: 'a'.repeat(40), classification,
    mainReceipt: { green } };
  const event = { event_kind: 'flake-observation', event_id: 1, event_at: '2026-01-01T00:00:00Z',
    event_detail: JSON.stringify({ engine: NATIVE_FLAKE_ENGINE, observation }) };
  const board = { db: { prepare: () => ({ all: () => [event] }) } };
  return { state: { board, config: { flakes: { rerun: true } }, batch: { base: observation.main } },
    gate: { failures: [failure], flakeDiagnostics: { observations: [{ id: observation.id, recorded: true, classification }] } } };
}

test('local-trunk attribution refuses a known main red without blaming an item [B3,R3,C7]', () => {
  const { state, gate } = fixture('stable-red', false);
  assert.throws(() => requireLocalGuardClassification(state, gate), { code: 'LAND_DIAGNOSTIC' });
});

test('local-trunk attribution accepts the exact failure paired with green pinned main [B3,R3,C7]', () => {
  const { state, gate } = fixture('possible-regression', true);
  assert.doesNotThrow(() => requireLocalGuardClassification(state, gate));
  state.batch.base = 'b'.repeat(40);
  assert.throws(() => requireLocalGuardClassification(state, gate), { code: 'LAND_DIAGNOSTIC' });
});

test('local-trunk attribution holds unknown diagnostics and preserves rerun-off policy [B3,R3,C7]', () => {
  const { state, gate } = fixture('unclassified', false);
  assert.throws(() => requireLocalGuardClassification(state, gate), { code: 'LAND_DIAGNOSTIC' });
  state.config.flakes.rerun = false;
  assert.doesNotThrow(() => requireLocalGuardClassification(state, gate));
});
