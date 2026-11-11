/** @pullboard-test-input source-tree */
/** Two real composed Submit pairs file one quarantine, keep raw receipts and lift after twenty clean runs [C7,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../../tests/fixtures/cases/quarantine-submit.js';
import { snapshot } from '../../../tests/fixtures/cases/quarantine-submit.js';
import { submit } from '../../../tests/fixtures/cases/quarantine-submit.js';
import { openFixtureBoard } from '../../../tests/fixtures/cases/quarantine-submit.js';
import { TITLE } from '../../../../../packages/git/tests/fixtures/flakes.js';
import * as store from '../../../../../packages/store/index.js';
import { recordGateRun } from '../../../../../packages/flakes/index.js';
import { requireSubmitDiagnosticAdmission } from '../../../../../packages/flakes/index.js';
import { recordGateRun as recordGateRunMove } from '../../../../../packages/moves/index.js';
import { AUTO_SUBMIT_QUARANTINE_ENGINE } from '../../../../../packages/state/light.js';
import { proofRunReceipt } from '../../../../../packages/store/index.js';
import { readGateReceipt } from '../../../../../packages/gate/index.js';
import { receiptStore } from '../../../../../packages/gate/index.js';

test('clause 1: two actual composed Submit pairs quarantine once, retain raw receipts, and let the third computed verdict through [C7,H16]', t => {
  const companion = true;
  const box = fixture(t, false, companion);
  assert.equal(snapshot(box).quarantines.length, 0, 'the setup must not seed a legacy quarantine');
  const first = submit(box);
  assert.equal(first.code, 1, JSON.stringify(first.document));
  // f562d717d8: a Submit pair files its quarantine at once, so the first pair already holds the one active repair.
  assert.equal(snapshot(box).quarantines.length, 1, JSON.stringify({ stderr: String(first.stderr ?? '').slice(-2500), quarantines: snapshot(box).quarantines, jobs: snapshot(box).jobs, runs: snapshot(box).runs.map(run => ({ id: run.id, kind: run.kind, proof: run.proof, outcomes: run.testOutcomes })) }));
  const second = submit(box);
  assert.equal(second.code, 0, JSON.stringify(second.document)); // the active quarantine lets the computed verdict through
  const state = snapshot(box);
  assert.equal(state.quarantines.length, 1, JSON.stringify({ first: first.document, second: second.document, quarantines: state.quarantines, runs: state.runs.map(({ id, kind, proof, testOutcomes }) => ({ id, kind, proof, testOutcomes })) }));
  const entry = state.quarantines[0];
  assert.equal(entry.nativeCore, true); // the Submit backfill marks its quarantine nativeCore (f562d717d8)
  assert.equal(entry.name, TITLE);
  assert.equal(entry.status, 'quarantined');
  const repair = state.items.find(item => item.item_id === entry.item);
  assert.equal(repair.item_lane, 'core');
  assert.equal(state.items.filter(item => item.item_title.startsWith('Flaky test:')).length, 1, 'typed diagnostics and quarantine share one owner');
  assert.equal(entry.runs.length, 2, 'the second pair never files a second quarantine');
  const receipts = entry.runs.map(id => readGateReceipt(receiptStore(box.root), id));
  assert.ok(receipts.every(Boolean), 'both proving receipts are native-produced private bytes');
  if (companion) assert.ok(receipts.every(receipt => receipt.head !== box.builder.git('rev-parse', 'HEAD')), 'all proving receipts execute the actual composition, not the bare builder head');
  assert.equal(new Set(receipts.map(receipt => receipt.proof.diagnosticAdmission)).size, 1);
  assert.equal(state.admissions.length, 2, 'each actually acquired Submit lease creates exactly one authenticated native witness');
  assert.ok(receipts.every(receipt => state.admissions.some(admission => admission.id === receipt.proof.diagnosticAdmission)));
  // These are synthetic validator inputs copied from actual sealed native bytes, never execution receipts or writes.
  const admissionBoard = openFixtureBoard(box);
  try {
    for (const receipt of receipts) {
      requireSubmitDiagnosticAdmission(admissionBoard, receipt.proof.seat, receipt);
      const request = { agentId: receipt.proof.seat, receipt };
      assert.ok(recordGateRunMove.minimumEngine([request]) >= AUTO_SUBMIT_QUARANTINE_ENGINE, 'omitted auto flag cannot downgrade marked evidence');
      assert.equal(recordGateRun(admissionBoard, request).duplicate, true, 'omitted auto flag preserves native automatic mode');
      for (const changed of [
        { ...receipt, proof: { ...receipt.proof, diagnosticAdmission: '00000000-0000-0000-0000-000000000000' } },
        { ...receipt, proof: { ...receipt.proof, item: box.id + 1 } },
        { ...receipt, proof: { ...receipt.proof, seat: 'core-unrelated' } },
        { ...receipt, tree: '0'.repeat(40) },
        { ...receipt, head: '0'.repeat(40) },
        { ...receipt, at: '2000-01-01T00:00:00.000Z' },
        ...(receipt.kind === 'check' ? [{ ...receipt, proof: { ...receipt.proof, submitPhase: undefined } }] : []),
        { ...receipt, proof: { ...receipt.proof, frozenDigest: '0'.repeat(64) } },
      ]) assert.throws(() => requireSubmitDiagnosticAdmission(admissionBoard, receipt.proof.seat, changed), error => error.code === 'GATE_RUN_UNBOUND');
      const stripped = structuredClone(receipt);
      delete stripped.proof.diagnosticAdmission;
      assert.throws(() => recordGateRun(admissionBoard, { ...request, receipt: stripped }), error => error.code === 'GATE_RUN_UNBOUND', 'removing purpose cannot reuse sealed bytes as legacy inference');
      assert.throws(() => recordGateRun(admissionBoard, { ...request, autoSubmit: false }), error => error.code === 'GATE_RUN_EVIDENCE');
    }
  } finally { store.closeBoard(admissionBoard); }
  for (const receipt of receipts.filter(receipt => receipt.kind === 'check')) {
    assert.equal(receipt.proof.submitPhase, 'diagnostic');
    assert.equal(receipt.proof.frozenDigest, null, 'a diagnostic cannot attest the frozen Submit bar');
    const board = openFixtureBoard(box);
    try { assert.throws(() => proofRunReceipt(board, { agentId: receipt.proof.seat, itemId: box.id, receiptId: receipt.id }), error => error.code === 'PROOF_RUN_STALE'); }
    finally { store.closeBoard(board); }
  }
  const ledger = box.cli('flakes').document;
  const row = ledger.regressions.find(value => value.file === 'test/alternating.test.mjs' && value.name === TITLE);
  assert.ok(row);
  assert.equal(row.classification, 'possible-regression');
  assert.ok(row.observations.length >= 1 && row.observations.every(observation => observation.kind === 'submit'
    && observation.classification === 'possible-regression'
    && observation.original.green === false && observation.paired?.green === true && observation.mainReceipt?.green === true));
  for (const observation of row.observations) {
    for (const evidence of [observation.original, observation.paired]) {
      const raw = box.readData(join(box.root, '.git/pullboard', evidence.artifact), 'utf8');
      assert.match(raw, /controlled intermittent assertion/);
    }
  }
  // f562d717d8: the Submit backfill files an ordinary nativeCore quarantine, not an autoSubmit one, so health lists none.
  assert.deepEqual(box.cli('health').document.autoQuarantines, []);
});
