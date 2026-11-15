/** @pullboard-test-input source-cell runners */
/** A runner request names its item and purpose, and the refusal for one that does not waits behind a setting that defaults off [C7,#4000]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { requestFor } from '../../index.js';

const RUNNER = { host: 'attribution.invalid', slots: 1, browser: 0 };
const PORTS = { privateCheckEnvelope: () => null };

/** Build one request in a machine home holding these settings; resolves to the refusal code, or null when the request got past attribution. */
async function codeWith(t, settings, metadata) {
  const { root: scratch } = privateFixtureFiles('pb-attribution-');
  const home = join(scratch, 'machine-home');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(scratch, { recursive: true, force: true });
  });
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  // The scratch root is no repository, so a request that passes attribution stops at its source check.
  const root = scratch;
  try { await requestFor(root, 'true', { runner: RUNNER, metadata }, PORTS); return { code: null }; }
  catch (error) { return { code: error.code ?? error.name, message: error.message }; }
}

test('clause 1: with gate.requireRunnerAttribution on, a request without an item is refused naming metadata.item [C7]', async t => {
  const refused = await codeWith(t, { gate: { requireRunnerAttribution: true } }, { kind: 'gate' });
  assert.equal(refused.code, 'RUNNER_UNATTRIBUTED');
  assert.match(refused.message, /metadata\.item/u);
});

test('clause 1: with gate.requireRunnerAttribution on, a request without a kind is refused naming metadata.kind [C7]', async t => {
  const refused = await codeWith(t, { gate: { requireRunnerAttribution: true } }, { item: '4000', kind: '' });
  assert.equal(refused.code, 'RUNNER_UNATTRIBUTED');
  assert.match(refused.message, /metadata\.kind/u);
  assert.equal((await codeWith(t, { gate: { requireRunnerAttribution: true } }, undefined)).code, 'RUNNER_UNATTRIBUTED');
});

test('clause 1: a request naming both an item and a kind passes the attribution check [C7]', async t => {
  assert.notEqual((await codeWith(t, { gate: { requireRunnerAttribution: true } }, { item: 'fixture', kind: 'remote-command' })).code, 'RUNNER_UNATTRIBUTED');
});

test('clause 1: the refusal is off by default, so a request naming neither still builds as before [C7]', async t => {
  assert.notEqual((await codeWith(t, {}, {})).code, 'RUNNER_UNATTRIBUTED');
  assert.notEqual((await codeWith(t, { gate: { requireRunnerAttribution: false } }, {})).code, 'RUNNER_UNATTRIBUTED');
});
