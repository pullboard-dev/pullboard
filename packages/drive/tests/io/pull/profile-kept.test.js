/** @pullboard-test-input source-cell packages/drive */
/** With gate.pulledProfilePaths on, a pulled gate job's phase timing profiles are kept beside their logs and named on the posted rows [C7,#9614]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runPhaseRows } from '../../fixtures/pull-phase-rows.js';

/** The posted receipt of one fake pulled job that wrote a profile for each phase, its two folders removed afterwards. */
function posted(t, options) {
  const { root: trunk } = privateFixtureFiles('pullboard-profile-kept-');
  const { root: cache } = privateFixtureFiles('pullboard-profile-kept-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  return runPhaseRows(trunk, cache, { profiles: true, ...options });
}

test('drive.profile-kept.two-profiles-in-the-kept-folder: clause 1: with gate.pulledProfilePaths on, the check and proof timing profiles are two files in the job\'s kept folder [C7,#9614]', { timeout: 60_000 }, // budget: one node job and a local git checkout.
async t => {
  const { receipt } = await posted(t, { pulledProfilePaths: true });
  const folder = receipt.output.folder;
  const kept = readdirSync(folder).filter(name => name.endsWith('.profile.json')).sort();
  assert.deepEqual(kept, ['check.log.profile.json', 'proof.log.profile.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, kept[0]), 'utf8')), { phase: 'check' });
  assert.deepEqual(JSON.parse(readFileSync(join(folder, kept[1]), 'utf8')), { phase: 'proof' });
});

test('drive.profile-kept.rows-name-the-kept-file: clause 2: the posted check and proof rows each carry profileKept as one plain file name that exists in the kept folder [C7,#9614]', { timeout: 60_000 }, // budget: one node job and a local git checkout.
async t => {
  const { receipt } = await posted(t, { pulledProfilePaths: true });
  const { check, proof } = receipt.gate;
  assert.equal(check.profileKept, 'check.log.profile.json');
  assert.equal(proof.profileKept, 'proof.log.profile.json');
  for (const row of [check, proof]) assert.ok(existsSync(join(receipt.output.folder, row.profileKept)), `${row.profileKept} is in the kept folder`);
});

test('drive.profile-kept.setting-off-keeps-nothing: clause 3: with the setting off the receipt has no profileKept and no profile file is kept [C7,#9614]', { timeout: 60_000 }, // budget: one node job and a local git checkout.
async t => {
  const { receipt } = await posted(t, { pulledProfilePaths: false });
  assert.equal('profileKept' in receipt.gate.check, false);
  assert.equal('profileKept' in receipt.gate.proof, false);
  assert.deepEqual(readdirSync(receipt.output.folder).filter(name => name.endsWith('.profile.json')), []);
});
