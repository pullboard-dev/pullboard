/** Fixture machine homes enable in-process hooks by default while honoring explicit fixture settings [C7]. @pullboard-test-input source-cell packages/gate */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../config/index.js';
import { privateFixtureFiles } from './fixtures/child.js';
import { fixtureSettledMachine } from './fixtures/testkit.js';

/** Write fixture settings in a private home and read them through the product settings loader. */
function settingsWith(t, envValue, settings = {}) {
  const { root } = privateFixtureFiles('pullboard-testkit-hooks-');
  const savedHome = process.env.PULLBOARD_MACHINE_HOME;
  const savedHooks = process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS;
  t.after(() => {
    if (savedHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = savedHome;
    if (savedHooks === undefined) delete process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS;
    else process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS = savedHooks;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'home');
  if (envValue === undefined) delete process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS;
  else process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS = envValue;
  fixtureSettledMachine(process.env.PULLBOARD_MACHINE_HOME, settings);
  return {
    loaded: loadMachineSettings(),
    written: JSON.parse(readFileSync(join(process.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')),
  };
}

test('gate.testkit-hooks.default-on: clause 1: fixtureSettledMachine writes test.inProcessHooks true by default and preserves other settings [C7]', (t) => {
  const { loaded, written } = settingsWith(t, undefined, { gateSlots: 3, gate: { maxChildren: 2 }, test: { custom: true } });
  assert.equal(loaded.test.inProcessHooks, true);
  assert.equal(written.gateSlots, 3);
  assert.deepEqual(loaded.gate, { maxChildren: 2, runnerDispatch: 'pull' });
  assert.equal(loaded.test.custom, true);
});

test('gate.testkit-hooks.environment-off: clause 1: PULLBOARD_FIXTURE_INPROCESS_HOOKS=0 suppresses the default [C7]', (t) => {
  const { loaded } = settingsWith(t, '0');
  assert.equal(loaded.test?.inProcessHooks, undefined);
});

test('gate.testkit-hooks.explicit-values: clause 1: explicit false and true fixture values both win over the default [C7]', (t) => {
  assert.equal(settingsWith(t, undefined, { test: { inProcessHooks: false } }).loaded.test.inProcessHooks, false);
  assert.equal(settingsWith(t, '0', { test: { inProcessHooks: true } }).loaded.test.inProcessHooks, true);
});
