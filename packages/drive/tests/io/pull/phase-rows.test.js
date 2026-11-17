/** @pullboard-test-input source-cell packages/drive */
/** A pulled gate job's check and proof phase rows reach the board in the posted receipt as the job printed them [C7,#9778]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runPhaseRows } from '../../fixtures/pull-phase-rows.js';

/** The posted receipt of one fake pulled job, its two folders removed afterwards. */
function posted(t) {
  const { root: trunk } = privateFixtureFiles('pullboard-phase-rows-');
  const { root: cache } = privateFixtureFiles('pullboard-phase-rows-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  return runPhaseRows(trunk, cache);
}

test('clause 1: a fake pulled job printing a check and a proof phase row posts a receipt keeping both rows (#9778) [C7]', { timeout: 60_000 }, // budget: one node job and a local git checkout.
async t => {
  const { receipt } = await posted(t);
  assert.ok(receipt, 'the runner posted a receipt');
  const { check, proof } = receipt.gate;
  assert.equal(check.green, true);
  assert.equal(proof.green, true);
  for (const row of [check, proof]) assert.match(row.profilePath, new RegExp(`${row.log.replace('.', '\\.')}\\.profile\\.json$`, 'u'), 'the profile path names the row\'s log');
  assert.notEqual(check.profilePath, proof.profilePath, 'each row keeps its own profile path');
});

test('clause 2: the posted rows keep their kept log names unchanged (#9778) [C7]', { timeout: 60_000 }, // budget: one node job and a local git checkout.
async t => {
  const { receipt } = await posted(t);
  assert.deepEqual([receipt.gate.check.name, receipt.gate.check.log, receipt.gate.proof.name, receipt.gate.proof.log], ['check', 'check.log', 'proof', 'proof.log']);
});
