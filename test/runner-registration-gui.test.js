/** Registration measures desktop capability before any GUI-marked job [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { registrationGuiFixture } from './runner-registration-gui-fixture.js';

test('runner add observes a desktop before the first GUI-marked gate runs [C7,V4]', async t => {
  const box = registrationGuiFixture(t);
  assert.equal(box.register().gui, true);
  assert.equal(box.trace('').length, 0, 'no job ran to teach the controller its GUI capability');
  assert.equal(box.trace('.gui-probes').length, 1, 'the registration probe really crossed the private SSH transport');
  assert.equal(box.trace('.gui-probes')[0].registrationGuiProbe, true);
  const observed = box.list()[0];
  assert.equal(observed.gui, true);
  assert.ok(Number.isFinite(Date.parse(observed.guiObservedAt)), 'registration persisted the fresh resource observation before any job');
  const run = await box.runGui();
  assert.equal(run.status, 0, run.context);
  assert.equal(box.result(run.stdout).isGreen, true);
  assert.equal(existsSync(box.marker), true, 'the GUI-marked file actually executed on the first job');
  assert.equal(box.trace('').length, 1);
  assert.equal(box.trace('.gui-probes').length, 1, 'a completed job was not needed to discover the initial desktop');
});

test('registration records known absence and refreshes a previous desktop observation [C7,V4]', t => {
  const box = registrationGuiFixture(t);
  assert.equal(box.register().gui, true);
  box.setMode('absent');
  assert.equal(box.register().gui, false);
  assert.equal(box.list()[0].gui, false, 'fresh registration replaces an old positive resource observation');
  assert.equal(box.trace('').length, 0);
  assert.equal(box.trace('.gui-probes').length, 2);
});

test('an inconclusive desktop probe remains unknown rather than inventing absence or presence [C7,V4]', t => {
  const box = registrationGuiFixture(t, 'unknown');
  assert.equal(box.register().gui, null);
  assert.equal(box.list()[0].gui, null);
  assert.equal(box.trace('').length, 0);
  assert.equal(box.trace('.gui-probes').length, 1);
});


test('failed registration transport replaces a stale desktop positive with unknown [C7,V4]', t => {
  const box = registrationGuiFixture(t);
  assert.equal(box.register().gui, true);
  box.transportDown();
  assert.equal(box.register().gui, null);
  assert.equal(box.list()[0].gui, null, 'a failed probe cannot retain a stale positive admission fact');
  assert.equal(box.trace('').length, 0);
  const probes = box.trace('.gui-probes');
  assert.equal(probes.length, 2);
  assert.equal(probes[1].healthProbeFailed, true, 'the private SSH transport really refused the new probe');
});
