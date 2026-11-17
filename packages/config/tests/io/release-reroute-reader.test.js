/** @pullboard-test-input source-cell config */
/** releaseRerouteUntouched() reads release.rerouteUntouched, off unless an exact true [C7,#9759]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as config from '../../index.js';
import { releaseRerouteUntouched } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-reroute-untouched-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: releaseRerouteUntouched() is false when release.rerouteUntouched is unset [C7,#9759]', () => {
  assert.equal(withSettings({}, releaseRerouteUntouched), false);
  assert.equal(withSettings({ release: {} }, releaseRerouteUntouched), false);
});

test('clause 2: releaseRerouteUntouched() is true only for an exact true [C7,#9759]', () => {
  assert.equal(withSettings({ release: { rerouteUntouched: true } }, releaseRerouteUntouched), true);
  assert.equal(withSettings({ release: { rerouteUntouched: false } }, releaseRerouteUntouched), false);
});

test('clause 3: releaseRerouteUntouched is exported by packages/config/index.js [C7,#9759]', () => {
  assert.equal(typeof config.releaseRerouteUntouched, 'function');
});
