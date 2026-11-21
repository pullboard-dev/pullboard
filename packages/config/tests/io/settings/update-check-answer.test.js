/** The person's answer to the release-check question is stored once and read back as asked [O1,C7,#12108]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../src/io/settings.js';
import { recordUpdateCheckAnswer } from '../../../src/io/settings.js';
import { updateCheckAsked } from '../../../src/io/settings.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run the body on a private machine home holding the given settings. */
function onHome(settings, body) {
  const { root: dir } = privateFixtureFiles('pullboard-update-answer-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return body();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-update-check-answer.answer-written-and-read-back: clause 1: recording a yes or no writes update.check to the machine settings file, and the asked reader returns true afterwards and false on a home that never answered [O1,C7,#12108]', () => {
  onHome({}, () => assert.equal(updateCheckAsked(), false));
  onHome({}, () => {
    recordUpdateCheckAnswer(true);
    assert.equal(loadMachineSettings().update.check, true);
    assert.equal(updateCheckAsked(), true);
  });
  onHome({ gate: { retryNewRedsOnce: true } }, () => {
    recordUpdateCheckAnswer(false);
    assert.equal(loadMachineSettings().update.check, false);
    assert.equal(updateCheckAsked(), true);
    assert.equal(loadMachineSettings().gate.retryNewRedsOnce, true);
  });
});
