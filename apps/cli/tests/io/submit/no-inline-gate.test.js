/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin: clause 1 reads the submit command source and imports the gate and landing front doors to prove submitHere runs no gate in its own process [C7,#6489]. */
/** submitHere reaches a gate only through offerSubmitGate; no gate-run export of the gate or landing doors is imported or called by the submit command [C7,#6489]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const SUBMIT = read('../../../src/io/commands/submit.js');
const GATE_DOOR = await import('../../../../../packages/gate/index.js');
const LANDING_DOOR = await import('../../../../../packages/landing/index.js');
/** Exports of the gate and landing doors that run a gate, a suite or a landing job inside the calling process. */
const GATE_RUNNERS = ['runSubmitGate', 'runStaticChecks', 'runFullSuite', 'runTestFiles', 'runFrozenProof', 'runProfiledShell', 'runProfiledShellAsync', 'runGateStages', 'runShell', 'startCriterionRun', 'runLandingJob', 'runChainedLandingJob'];

/** The source of one top-level function, from its declaration to the closing brace at column 0. */
function bodyOf(source, name) {
  const from = source.indexOf(`function ${name}(`);
  assert.ok(from >= 0, `${name} is declared in the submit command`);
  const to = source.indexOf('\n}\n', from);
  assert.ok(to > from, `${name} has a closing brace at column 0`);
  return source.slice(from, to + 2);
}

const exported = name => name in GATE_DOOR || name in LANDING_DOOR;
const named = (source, name) => new RegExp(`\\b${name}\\b`, 'u').test(source);

test('cli.io-submit-no-inline-gate.submit-here-reaches-a-gate-only-through-offer-submit-gate: clause 1: submitHere calls offerSubmitGate and calls no function that runs a gate in the process [C7,#6489]', () => {
  const body = bodyOf(SUBMIT, 'submitHere');
  assert.match(body, /\bofferSubmitGate\(/u, 'submitHere offers the gate to a runner through offerSubmitGate');
  assert.deepEqual(GATE_RUNNERS.filter(name => new RegExp(`\\b${name}\\s*\\(`, 'u').test(body)), [], 'submitHere calls no gate-run function');
  assert.deepEqual(GATE_RUNNERS.filter(name => !exported(name)), [], 'every name checked is still a gate-run export of the gate or landing door');
});

test('cli.io-submit-no-inline-gate.the-submit-command-imports-no-gate-run-export: clause 1: apps/cli/src/io/commands/submit.js names none of the gate-run exports of the gate and landing doors [C7,#6489]', () => {
  assert.deepEqual(GATE_RUNNERS.filter(name => named(SUBMIT, name)), [], 'the submit command neither imports nor mentions a gate-run export');
});
