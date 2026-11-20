/** A settled pulled gate carries the kept check and proof timing profile paths beside its sanitized log, with gate.pulledProfilePaths on [C7,#7301]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { PROFILED_CHECK } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/** Run one profiled pulled gate to its receipt on the board and return that receipt. */
async function settledGate(t) {
  const box = await pullProject(t, 1, { check: () => PROFILED_CHECK });
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const receiptOf = () => jobsOf(board.db, { kind: 'gate', item: id })[0]?.steps.find(step => step.name === 'receipt')?.payload?.receipt ?? null;
  for (let round = 0; round < 4 && !receiptOf(); round++) {
    const served = await serveOnce(box, url, `r-prof-${round}`, {}, { machineSettings: { gate: { pulledProfilePaths: true } } });
    assert.equal(served.code, 0, served.output);
  }
  const receipt = receiptOf();
  assert.ok(receipt, 'the gate job posted a receipt');
  return receipt;
}

/** The profile file the receipt's phase kept in the job's kept output folder, null when it names none. */
function keptProfile(receipt, role) {
  const name = receipt.gate?.phases?.find(phase => phase?.role === role)?.profileKept;
  return receipt.output?.folder && typeof name === 'string' ? join(receipt.output.folder, name) : null;
}

test('cli.journeys-gate-pulled-profile.check-profile-beside-log: clause 1: with gate.pulledProfilePaths on, the check profile file the settled pulled gate names exists beside its sanitized log [C7,#7301]', { timeout: 240_000 }, async t => {
  const receipt = await settledGate(t);
  const path = keptProfile(receipt, 'check');
  assert.ok(path, `the settled gate names its check profile: ${JSON.stringify({ phases: receipt.gate?.phases?.map(phase => [phase.role, phase.profileKept, typeof phase.profilePath]), keys: Object.keys(receipt.gate ?? {}), kept: receipt.output?.folder?.slice(-40) })}`);
  assert.ok(existsSync(path), `${path} exists`);
});

test('cli.journeys-gate-pulled-profile.proof-profile-beside-log: clause 2: with gate.pulledProfilePaths on, the proof profile file the settled pulled gate names exists beside its sanitized log [C7,#7301]', { timeout: 240_000 }, async t => {
  const receipt = await settledGate(t);
  const path = keptProfile(receipt, 'proof');
  assert.ok(path, `the settled gate names its proof profile: ${JSON.stringify({ phases: receipt.gate?.phases?.map(phase => [phase.role, phase.profileKept, typeof phase.profilePath]), keys: Object.keys(receipt.gate ?? {}), kept: receipt.output?.folder?.slice(-40) })}`);
  assert.ok(existsSync(path), `${path} exists`);
});
