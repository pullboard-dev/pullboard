/** joinCoordinatorSeat reads the flat dotted key as other machine settings do, and the nested form still works [C7,#10669]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapterLintSshEnabled } from '../../index.js';
import { failFastShardsEnabled } from '../../index.js';
import { holdsLiftSettled } from '../../index.js';
import { excuseMainRedFilesEnabled } from '../../index.js';
import { joinCoordinatorSeat } from '../../index.js';
import { jsdocCheckEnabled } from '../../index.js';
import { relaxRequiredFamilyEnabled } from '../../index.js';
import { claimCheckCeilingEnabled } from '../../index.js';
import { adapterLintGithubEnabled } from '../../index.js';
import { adapterLintSigningEnabled } from '../../index.js';
import { loadMachineSettings } from '../../index.js';
import { runnersCoresPerShard } from '../../index.js';
import { describeSetting } from '../../index.js';
import { MACHINE_DEFAULTS } from '../../src/io/settings/machine-defaults.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-join-seat-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings.join-coordinator-seat-flat-key: clause 1: joinCoordinatorSeat() is true when the flat key "join.coordinatorSeat" is true [C7,#10669]', () => {
  assert.equal(withSettings({ 'join.coordinatorSeat': true }, joinCoordinatorSeat), true);
  assert.equal(withSettings({ join: { coordinatorSeat: true } }, joinCoordinatorSeat), true);
});

test('config.io-settings.join-coordinator-seat-off-by-default: clause 2: joinCoordinatorSeat() is false when neither key is set, and a non-boolean flat key is refused [C7,#10669]', () => {
  assert.equal(withSettings({}, joinCoordinatorSeat), false);
  assert.equal(withSettings({ 'join.coordinatorSeat': false }, joinCoordinatorSeat), false);
  assert.throws(() => withSettings({ 'join.coordinatorSeat': 'yes' }, joinCoordinatorSeat), /join\.coordinatorSeat/u);
});

test('config.io-settings.relax-required-family-enabled: clause 1: relaxRequiredFamilyEnabled() is false for empty settings and for review.relaxRequiredFamily false, and true only for an exact true [C7]', () => {
  assert.equal(withSettings({}, relaxRequiredFamilyEnabled), false);
  assert.equal(withSettings({ review: { relaxRequiredFamily: false } }, relaxRequiredFamilyEnabled), false);
  assert.equal(withSettings({ review: { relaxRequiredFamily: 'true' } }, relaxRequiredFamilyEnabled), false);
  assert.equal(withSettings({ review: { relaxRequiredFamily: true } }, relaxRequiredFamilyEnabled), true);
});

test('config.io-settings.claim-check-ceiling-reads-false-unset: clause 1: claim.checkCeiling reads false when unset and true only when set true, a non-boolean is refused BAD_MACHINE_SETTINGS, and claimCheckCeilingEnabled() follows it [C7,#1273]', () => {
  assert.equal(withSettings({}, claimCheckCeilingEnabled), false);
  assert.equal(withSettings({ claim: { checkCeiling: false } }, claimCheckCeilingEnabled), false);
  assert.equal(withSettings({ claim: { checkCeiling: true } }, claimCheckCeilingEnabled), true);
  assert.throws(() => withSettings({ claim: { checkCeiling: 'yes' } }, claimCheckCeilingEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /claim\.checkCeiling/u.test(error.message));
});

test('config.io-settings.adapter-lint-github-enabled: clause 1: adapterLintGithubEnabled() reads false when unset and true only when gate.adapterLintGithub is set true, and a non-boolean is refused BAD_MACHINE_SETTINGS [C7,#1429]', () => {
  assert.equal(withSettings({}, adapterLintGithubEnabled), false);
  assert.equal(withSettings({ gate: { adapterLintGithub: false } }, adapterLintGithubEnabled), false);
  assert.equal(withSettings({ gate: { adapterLintGithub: true } }, adapterLintGithubEnabled), true);
  assert.throws(() => withSettings({ gate: { adapterLintGithub: 'yes' } }, adapterLintGithubEnabled), { code: 'BAD_MACHINE_SETTINGS' });
});

test('config.io-settings.adapter-lint-github-described: clause 2: describeSetting(gate.adapterLintGithub) names the GitHub adapter and MACHINE_DEFAULTS holds the setting false [C7,#1429]', () => {
  const row = describeSetting('gate.adapterLintGithub');
  assert.ok(row, 'description row exists');
  assert.match(JSON.stringify(row), /GitHub adapter/u);
  assert.equal(MACHINE_DEFAULTS['gate.adapterLintGithub'], false);
});

test('config.io-settings.adapter-lint-signing-reads-boolean: clause 1: gate.adapterLintSigning reads false when unset and true only when set true, a non-boolean is refused BAD_MACHINE_SETTINGS, and adapterLintSigningEnabled() follows it [C7,#1428]', () => {
  assert.equal(withSettings({}, adapterLintSigningEnabled), false);
  assert.equal(withSettings({ gate: { adapterLintSigning: false } }, adapterLintSigningEnabled), false);
  assert.equal(withSettings({ gate: { adapterLintSigning: true } }, adapterLintSigningEnabled), true);
  assert.throws(() => withSettings({ gate: { adapterLintSigning: 'true' } }, adapterLintSigningEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.adapterLintSigning/u.test(error.message));
});

test('config.io-settings.adapter-lint-signing-described-off: clause 2: describeSetting names the signing adapter and MACHINE_DEFAULTS holds gate.adapterLintSigning false [C7,#1428]', () => {
  assert.match(describeSetting('gate.adapterLintSigning').description, /signing adapter/u);
  assert.equal(MACHINE_DEFAULTS['gate.adapterLintSigning'], false);
});

test('config.io-settings.adapter-lint-ssh-reads-off-unless-true: clause 1: gate.adapterLintSsh reads false when unset and true only when set true, and a non-boolean is refused BAD_MACHINE_SETTINGS [C7,#11369]', () => {
  assert.equal(withSettings({}, adapterLintSshEnabled), false);
  assert.equal(withSettings({ gate: { adapterLintSsh: false } }, adapterLintSshEnabled), false);
  assert.equal(withSettings({ gate: { adapterLintSsh: true } }, adapterLintSshEnabled), true);
  assert.throws(() => withSettings({ gate: { adapterLintSsh: 'yes' } }, adapterLintSshEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.adapterLintSsh/u.test(error.message));
});

test('config.io-settings.adapter-lint-ssh-described-and-off: clause 2: describeSetting names the SSH runner adapter and MACHINE_DEFAULTS holds gate.adapterLintSsh false [C7,#11369]', () => {
  assert.match(describeSetting('gate.adapterLintSsh').description, /SSH runner adapter/u);
  assert.equal(MACHINE_DEFAULTS['gate.adapterLintSsh'], false);
});

test('config.io-settings.jsdoc-check-default-on: clause 1: gate.jsdocCheck reads true when unset and false only when set false, a non-boolean is refused BAD_MACHINE_SETTINGS, and jsdocCheckEnabled() follows it [C7,#1807]', () => {
  assert.equal(withSettings({}, jsdocCheckEnabled), true);
  assert.equal(withSettings({ gate: { jsdocCheck: false } }, jsdocCheckEnabled), false);
  assert.equal(withSettings({ gate: { jsdocCheck: true } }, jsdocCheckEnabled), true);
  assert.equal(withSettings({ gate: { jsdocCheck: false } }, () => loadMachineSettings().gate?.jsdocCheck === false), true);
  assert.throws(() => withSettings({ gate: { jsdocCheck: 'yes' } }, jsdocCheckEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.jsdocCheck/u.test(error.message));
});

test('config.io-settings.jsdoc-check-described-default-on: clause 1: describeSetting names JSDoc in the description of gate.jsdocCheck and MACHINE_DEFAULTS holds it true [C7,#1807]', () => {
  assert.match(JSON.stringify(describeSetting('gate.jsdocCheck')), /JSDoc/u);
  assert.equal(MACHINE_DEFAULTS['gate.jsdocCheck'], true);
});

test('config.io-settings.cores-per-shard-reads-three-unset: clause 1: runnersCoresPerShard() reads 3 when runners.coresPerShard is unset, 2 when set 2, and a value outside 1-5 or not whole is refused BAD_MACHINE_SETTINGS [C7,#11866]', () => {
  assert.equal(withSettings({}, runnersCoresPerShard), 3);
  assert.equal(withSettings({ 'runners.coresPerShard': 2 }, runnersCoresPerShard), 2);
  for (const bad of [0, 6, 2.5, '2']) {
    assert.throws(() => withSettings({ 'runners.coresPerShard': bad }, runnersCoresPerShard), error => error.code === 'BAD_MACHINE_SETTINGS' && /runners\.coresPerShard/u.test(error.message));
  }
});

test('config.io-settings.cores-per-shard-described-default-three: clause 2: MACHINE_DEFAULTS holds runners.coresPerShard 3 and describeSetting names cores in its description [C7,#11866]', () => {
  assert.equal(MACHINE_DEFAULTS['runners.coresPerShard'], 3);
  assert.match(JSON.stringify(describeSetting('runners.coresPerShard')), /cores/u);
});

test('config.io-settings.fail-fast-shards-setting: clause 1: gate.failFastShards defaults to false, rejects a non-boolean with BAD_MACHINE_SETTINGS, has a description row, and failFastShardsEnabled() is true only for an exact true [C7,#12038]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.failFastShards'], false);
  assert.match(describeSetting('gate.failFastShards').description, /remaining shards/iu);
  assert.equal(withSettings({}, failFastShardsEnabled), false);
  assert.equal(withSettings({ gate: { failFastShards: false } }, failFastShardsEnabled), false);
  assert.equal(withSettings({ gate: { failFastShards: true } }, failFastShardsEnabled), true);
  assert.throws(() => withSettings({ gate: { failFastShards: 'true' } }, failFastShardsEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.failFastShards/u.test(error.message));
});

test('config.io-settings.lift-settled-on: clause 1: holdsLiftSettled returns true with no settings file and false only when holds.liftSettled is set to false, and the machine default is true [C7,#12474]', () => {
  assert.equal(MACHINE_DEFAULTS['holds.liftSettled'], true);
  assert.equal(withSettings({}, holdsLiftSettled), true);
  assert.equal(withSettings({ holds: { liftSettled: true } }, holdsLiftSettled), true);
  assert.equal(withSettings({ holds: { liftSettled: false } }, holdsLiftSettled), false);
  assert.match(describeSetting('holds.liftSettled').description, /default/iu);
});

test('config.io-settings.excuse-main-red-files-setting: clause 1: gate.excuseMainRedFiles defaults to false, is described, rejects a non-boolean with BAD_MACHINE_SETTINGS, and excuseMainRedFilesEnabled() is true only for an exact true [C7,#12129]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.excuseMainRedFiles'], false);
  assert.match(describeSetting('gate.excuseMainRedFiles').description, /red on main|main also fails/iu);
  assert.equal(withSettings({}, excuseMainRedFilesEnabled), false);
  assert.equal(withSettings({ gate: { excuseMainRedFiles: false } }, excuseMainRedFilesEnabled), false);
  assert.equal(withSettings({ gate: { excuseMainRedFiles: true } }, excuseMainRedFilesEnabled), true);
  assert.throws(() => withSettings({ gate: { excuseMainRedFiles: 'true' } }, excuseMainRedFilesEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.excuseMainRedFiles/u.test(error.message));
});
