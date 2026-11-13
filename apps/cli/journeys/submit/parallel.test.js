/** Concurrent submit phases stay inside the audited serial bound of a pulled gate and keep independent raw results [V4,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { project } from '../../tests/fixtures/submit/parallel.js';
import { submit } from '../../tests/fixtures/submit/parallel.js';

// Budget: two deliberately twenty-second fixture checks; a pulled gate runs them together, so the whole CLI gets the longer plus the pulled gate's setup.
const SLOW_MS = 20_000;
const SETUP_MS = 40_000; // audited: the pulled gate spent 22.4 s outside the two checks when measured.

test('submit runs two slow checks together in a pulled gate and preserves both receipts [V4,C7]', { timeout: 120_000 }, async t => { // budget: a twenty-second check also runs once at add for its frozen baseline.
  const { box, observations } = project(t, SLOW_MS);
  const { result, gate, started, wallMs } = await submit(t, box, 'green');
  assert.equal(result.code, 0, result.err + result.out);
  const runs = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(-2);
  assert.deepEqual(new Set(runs.map(run => run.role)), new Set(['criterion', 'proof']));
  // A pulled gate job starts its check phase and its proof phase together (apps/cli/src/io/submit/pull.js GATE_JOB_ENTRY):
  // the proof starts within 1 s of the check, and the two 20 s phases finish in under 30 s of wall time (were 40.3 s serial; #7077).
  const slower = Math.max(...runs.map(run => run.end - run.start));
  assert.ok(slower >= SLOW_MS, `the inner check interval is at least the fixture sleep: ${slower}ms`);
  const gap = Math.max(...runs.map(run => run.start)) - Math.min(...runs.map(run => run.start));
  const span = Math.max(...runs.map(run => run.end)) - Math.min(...runs.map(run => run.start));
  const where = `before the checks ${Math.min(...runs.map(run => run.start)) - started}ms, after them ${started + wallMs - Math.max(...runs.map(run => run.end))}ms`;
  t.diagnostic(`submit ${wallMs}ms; inner check ${slower}ms; start gap ${gap}ms; span ${span}ms; ${where}; intervals ${JSON.stringify(runs)}`);
  assert.ok(gap < 1000, `the proof phase starts within 1 s of the check phase: ${gap}ms apart`);
  assert.ok(span < 30_000, `two ${SLOW_MS}ms phases overlap to under 30 s: ${span}ms`);
  assert.ok(wallMs <= slower + SETUP_MS, `submit ${wallMs}ms, inner check ${slower}ms; ${where}`);
  // A pulled gate posts one receipt whose phases are the two commands' own raw results.
  const phases = gate?.phases ?? [];
  assert.deepEqual(phases.map(phase => phase.role).toSorted(), ['check', 'proof'], 'each command retains its own raw phase result');
  assert.equal(new Set(phases.map(phase => phase.sha256)).size, 2);
  assert.ok(phases.every(phase => phase.status === 0) && gate?.green === true, JSON.stringify(gate));
  assert.equal(gate?.environment?.node, process.versions.node);
});
