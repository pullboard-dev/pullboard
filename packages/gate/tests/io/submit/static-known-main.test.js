/** @pullboard-test-input source-cell packages/gate */
/** With gate.knownMainStatic on, the submit gate hands the static step main's findings at the pinned main and carries the known rows on its result [C7,#10564]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executionServices } from '../../fixtures/execution.js';
import { runSubmitGate } from '../../../src/io/submit.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

const MAIN_ROW = 'packages/a/x.js:3: runs a git fetch outside the one entry point';
const ITEM_ROW = 'packages/b/y.js:9: tests read a cell by path';
const PLAN = { check: '', selection: { full: false, reason: '', files: [] }, deferred: false, deferFullFallback: false, deferSelection: false,
  invariants: [], registryGuards: [], proofFiles: [], fullConfig: { gate: 'true' }, hasFinalProof: false, phases: [], testTiers: null };

/** A committed fixture repository whose static command prints `rows` and exits red. */
function checkRepo(rows) {
  const { root } = privateFixtureFiles('pullboard-submit-known-main-');
  writeFileSync(join(root, 'check.sh'), `${rows.map(row => `echo 'STATIC_RED ${row}'`).join('\n')}\nexit 1\n`);
  fixtureProjectPolicy(root);
  fixtureCommitAll(root);
  return root;
}

/** The item's repository, under a machine home holding `settings`. */
function redRepo(t, rows, settings) {
  const root = checkRepo(rows);
  const home = join(root, '..', `${root.split('/').at(-1)}-machine`);
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  return root;
}

/** A main checkout whose static command prints main's one finding; the helper records the commit it was asked for. */
function mainCheckout(calls) {
  const main = checkRepo([MAIN_ROW]);
  return async (_root, commit, run) => { calls.push(commit); return run(main); };
}

/** The submit gate over `root` with a green criterion and no proof files, so only the static step decides. */
function submit(root, options) {
  return runSubmitGate(root, { gate: 'true', staticChecks: 'sh check.sh' }, { executionServices, plan: PLAN, ...options });
}

test('gate.io-submit-static-known-main.with-the-setting-on-a-red-only-in: clause 1: with the setting on, a static red only in main\'s findings returns a result carrying those rows as staticKnownMain [C7,#10564]', async t => {
  const root = redRepo(t, [MAIN_ROW], { gate: { knownMainStatic: true } });
  const calls = [];
  const result = await submit(root, { withMainCheckout: mainCheckout(calls) });
  assert.equal(result.isGreen, true);
  assert.deepEqual(result.staticKnownMain, [{ rule: 'runs a git fetch outside the one entry point', file: 'packages/a/x.js' }]);
  assert.equal(calls.length, 1, 'main was read once');
  assert.match(calls[0], /^[0-9a-f]{40}$/u, 'at a pinned commit');
});

test('gate.io-submit-static-known-main.a-finding-red-only-on-the-item: clause 2: a finding red only on the item still refuses GATE_RED, and with the setting off no main findings are read [C7,#10564]', async t => {
  const root = redRepo(t, [MAIN_ROW, ITEM_ROW], { gate: { knownMainStatic: true } });
  await assert.rejects(submit(root, { withMainCheckout: mainCheckout([]) }), error => {
    assert.equal(error.code, 'GATE_RED');
    assert.match(error.message, /packages\/b\/y\.js:9/u);
    return true;
  });
  const off = redRepo(t, [MAIN_ROW], {});
  const calls = [];
  await assert.rejects(submit(off, { withMainCheckout: mainCheckout(calls) }), error => error.code === 'GATE_RED');
  assert.deepEqual(calls, [], 'with the setting off main is never read');
});
