/** A runner job turns test.inProcessHooks on for every fixture machine home with one variable, and writes nothing about it otherwise [C7]. @pullboard-test-input source-cell packages/gate */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';
import { fixtureSettledMachine } from './fixtures/testkit.js';

/** Write a fixture machine home with the variable set to this value (undefined unsets it) and return its settings. */
function settingsWith(t, value, settings) {
  const home = privateFixtureFiles('pullboard-inprocess-env-').root;
  const before = process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS;
    else process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS = before;
    rmSync(home, { recursive: true, force: true });
  });
  if (value === undefined) delete process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS;
  else process.env.PULLBOARD_FIXTURE_INPROCESS_HOOKS = value;
  fixtureSettledMachine(home, settings);
  return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
}

test('gate.fixtures-inprocess-hooks-env.on-writes-true: clause 1: [C7] PULLBOARD_FIXTURE_INPROCESS_HOOKS=1 writes test.inProcessHooks true into the fixture machine home', (t) => {
  assert.equal(settingsWith(t, '1').test.inProcessHooks, true);
  assert.equal(settingsWith(t, '1', { test: { other: 2 } }).test.other, 2);
});

test('gate.fixtures-inprocess-hooks-env.off-writes-nothing: clause 1: [C7] unset or any other value writes nothing about test.inProcessHooks', (t) => {
  for (const value of [undefined, '0', '', 'true', 'yes']) {
    const written = settingsWith(t, value);
    assert.equal('test' in written, false, `value ${String(value)}`);
    assert.deepEqual(written.gate, { runnerDispatch: 'pull' });
  }
});
