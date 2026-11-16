/** gate.testNice is off by default, true or false only, and described [C7,#8509]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testNiceEnabled } from '../../../index.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Reads gate.testNice for a private machine home holding the given settings, restoring the home afterwards. */
function readWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-test-nice-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return testNiceEnabled();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: gate.testNice is off when unset and on only when set true [C7,#8509]', () => {
  assert.equal(readWith({}), false);
  assert.equal(readWith({ gate: { testNice: false } }), false);
  assert.equal(readWith({ gate: { testNice: true } }), true);
});

test('clause 2: a non-boolean gate.testNice is refused naming the setting [C7,#8509]', () => {
  assert.throws(() => readWith({ gate: { testNice: 'yes' } }), /gate\.testNice/u);
});

test('clause 3: gate.testNice has a settings description row [C7,#8509]', () => {
  assert.match(JSON.stringify(describeSetting('gate.testNice')), /scheduling priority/u);
});
