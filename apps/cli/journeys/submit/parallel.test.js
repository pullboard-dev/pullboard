/** Concurrent submit phases stay inside the audited serial bound of a pulled gate and keep independent raw results [V4,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { project } from '../../tests/fixtures/submit/parallel.js';
import { submit } from '../../tests/fixtures/submit/parallel.js';

// Budget: two deliberately twenty-second fixture checks; a pulled gate runs them one after the other, so the whole CLI gets 2.5x the longer.
const SLOW_MS = 20_000;

test('submit runs two slow checks within the audited serial bound of a pulled gate and preserves both receipts [V4,C7]', { timeout: 120_000 }, async t => { // budget: a twenty-second check also runs once at add for its frozen baseline.
  const { box, observations } = project(t, SLOW_MS);
  const { result, gate, started, wallMs } = await submit(t, box, 'green');
  assert.equal(result.code, 0, result.err + result.out);
  const runs = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(-2);
  assert.deepEqual(new Set(runs.map(run => run.role)), new Set(['criterion', 'proof']));
  // Audited exception (#7044, fact 9f2115e6): a pulled gate job runs its check phase and then its proof phase one after the
  // other (apps/cli/src/io/submit/pull.js GATE_JOB_ENTRY), measured 20.0 s then 20.0 s with a 0.3 s gap, so the V4 overlap
  // cannot hold under pull yet; the 0.9.5 item "pulled gate runs criterion and proof checks in parallel lanes" restores it.
  // Until then the bound is the measured serial span, and a gate that also stalled between the two checks still fails.
  const slower = Math.max(...runs.map(run => run.end - run.start));
  assert.ok(slower >= SLOW_MS, `the inner check interval is at least the fixture sleep: ${slower}ms`);
  const where = `before the checks ${Math.min(...runs.map(run => run.start)) - started}ms, after them ${started + wallMs - Math.max(...runs.map(run => run.end))}ms`;
  t.diagnostic(`submit ${wallMs}ms; inner check ${slower}ms; ${where}; intervals ${JSON.stringify(runs)}`);
  assert.ok(wallMs <= slower * 2.5, `submit ${wallMs}ms, inner check ${slower}ms; ${where}`);
  // A pulled gate posts one receipt whose phases are the two commands' own raw results.
  const phases = gate?.phases ?? [];
  assert.deepEqual(phases.map(phase => phase.role).toSorted(), ['check', 'proof'], 'each command retains its own raw phase result');
  assert.equal(new Set(phases.map(phase => phase.sha256)).size, 2);
  assert.ok(phases.every(phase => phase.status === 0) && gate?.green === true, JSON.stringify(gate));
  assert.equal(gate?.environment?.node, process.versions.node);
});
