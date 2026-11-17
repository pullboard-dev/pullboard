/** @pullboard-test-input source-cell packages/landing packages/gate */
/** @pullboard-world-pin: clause 1 reads the shipped landing and gate sources to prove no landing step blocks the lease heartbeat. */
/** A landing awaits every runner run, so its landing lease heartbeat keeps beating while tests run [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = file => readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8');

test('landing.awaits.no-landing-step-runs-a-test: clause 1: no landing step runs a test synchronously, which blocked the lease heartbeat until LAND_LEASE_LOST (9 Nov) [C7]', () => {
  const landing = ['packages/landing/src/io', 'packages/landing/src/logic']
    .flatMap(folder => readdirSync(new URL(`../../../../../${folder}`, import.meta.url), { recursive: true }).filter(name => name.endsWith('.js')).map(name => `${folder}/${name}`));
  for (const file of landing) {
    const text = read(file);
    assert.doesNotMatch(text, /\brunProfiledShell\(/u, `${file} runs a profiled shell synchronously`);
    assert.doesNotMatch(text, /\bfullGateRun\(/u, `${file} runs a full gate synchronously`);
  }
  const execution = read('packages/gate/src/io/execution.js');
  assert.match(execution, /: await fullGateRunAsync\(root, config, trustStamp, options\)/u, 'runGate awaits every gate run, landing or not');
  const comparison = /export async function runMainComparison[\s\S]*?\n\}/u.exec(execution)[0];
  assert.doesNotMatch(comparison, /[^c]\brunProfiledShell\(/u, 'a main comparison, which landing diagnostics run, is awaited');
});
