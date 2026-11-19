/** joinCoordinatorSeat reads the flat dotted key as other machine settings do, and the nested form still works [C7,#10669]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MACHINE_DEFAULTS } from '../../index.js';
import { adapterLintSshEnabled } from '../../index.js';
import { describeSetting } from '../../index.js';
import { joinCoordinatorSeat } from '../../index.js';
import { relaxRequiredFamilyEnabled } from '../../index.js';
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
