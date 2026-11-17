/** Synthetic private unit inputs exercise attribution policy; these are not operational evidence or board receipts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireLocalGuardClassification } from '../../../index.js';
import { landingPorts } from '../../../../../apps/cli/tests/fixtures/landing/ports.js';
import { NATIVE_FLAKE_ENGINE } from '../../../../state/light.js';

/** Supply private in-memory ledger inputs without writing operational observations or receipts. */
function fixture(classification, green) {
  const failure = { file: 'test/private.test.js', name: 'private behavior' };
  const observation = { ...failure, id: 'private-unit', main: 'a'.repeat(40), classification,
    mainReceipt: { green } };
  const event = { event_kind: 'flake-observation', event_id: 1, event_at: '2026-01-01T00:00:00Z',
    event_detail: JSON.stringify({ engine: NATIVE_FLAKE_ENGINE, observation }) };
  const board = { db: { prepare: () => ({ all: () => [event] }) } };
  return { state: { board, landingPorts, config: { flakes: { rerun: true } }, batch: { base: observation.main } },
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

test('clause 1: a guard run red only on SLOT_DB_LOCKED with no failing case refuses SLOT_DB_LOCKED, never LAND_DIAGNOSTIC [C7,#3314]', async () => {
  const { requireNoLockOnlyRed } = await import('../../../src/io/land/guard.js');
  const { landingFault } = await import('../../../src/io/step/diagnose.js');
  const log = 'run-tests: [SLOT_DB_LOCKED] never ran: resources.sqlite stayed locked for 10002ms';
  assert.throws(() => requireNoLockOnlyRed({ isGreen: false, failures: [], logPath: 'x.log' }, () => log),
    error => error.code === 'SLOT_DB_LOCKED' && landingFault(error));
  assert.doesNotThrow(() => requireNoLockOnlyRed({ isGreen: false, failures: [{ file: 'a.test.js', name: 'n' }], logPath: 'x.log' }, () => log));
  assert.doesNotThrow(() => requireNoLockOnlyRed({ isGreen: false, failures: [], logPath: 'x.log' }, () => 'not ok 1'));
  assert.doesNotThrow(() => requireNoLockOnlyRed({ isGreen: true, failures: [], logPath: 'x.log' }, () => log));
});
