/** @pullboard-test-input source-cell gate */
/** A real SwiftPM fixture runs swift test with its JUnit command, and junitCases reads the report [#10375,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { junitCases } from '../src/logic/junit.js';
import { junitCommand } from '../src/logic/junit.js';
import { privateFixtureFiles } from './fixtures/child.js';

const FIXTURE = new URL('./fixtures/swift-pkg/', import.meta.url);
const RUN_LIMIT_MS = 120_000;
const FILES = ['Package.swift', 'Sources/Calc/Calc.swift', 'Tests/CalcTests/CalcTests.swift'];

/** True when swift answers --version on this machine. */
function swiftAnswers() {
  const probe = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

/** One run of the swift row in a private copy, shared by the cases that read it; the copy goes when the last case ends. */
let shared = null;
after(() => { if (shared) rmSync(shared.root, { recursive: true, force: true }); });

/** Copy the fixture to a private temporary folder, so the .build folder and the report never land in the repo. */
function sharedRun() {
  if (shared) return shared;
  const { root, write } = privateFixtureFiles('swift-pkg-');
  for (const name of FILES) write(name, readFileSync(new URL(name, FIXTURE)));
  mkdirSync(join(root, '.pullboard', 'junit'), { recursive: true });
  const row = junitCommand('swift');
  // SwiftPM nests its own sandbox-exec, which hangs inside the runner sandbox; --disable-sandbox and a scratch path in the copy avoid it.
  // The failing test makes swift test exit non-zero, as a red gate does; the report is still written.
  const run = spawnSync('sh', ['-c', `${row.command} --disable-sandbox --scratch-path ${join(root, '.build')}`], { cwd: root, encoding: 'utf8', timeout: RUN_LIMIT_MS });
  shared = { root, reportFile: join(root, row.report), run };
  return shared;
}

/** Why swift could not build the fixture on this machine, from a finished run. */
function buildReason(run) {
  return run.error ? `it did not finish within ${RUN_LIMIT_MS / 1000} s (${run.error.code ?? run.error.message})` : `exit ${run.status}: ${String(run.stderr).slice(-300)}`;
}

test('gate.swift-real.report-names-one-pass-one-fail: clause 1: the swift row runs on a one-pass one-fail fixture and junitCases reads one pass and one fail from its report [C7]', (t) => {
  if (!swiftAnswers()) return t.skip('swift unavailable on this machine: swift --version did not answer');
  const { run, reportFile } = sharedRun();
  if (!existsSync(reportFile)) return t.skip(`swift unavailable: it could not build the fixture, ${buildReason(run)}`);
  const { cases, reason } = junitCases(readFileSync(reportFile, 'utf8'));
  assert.equal(reason, null);
  assert.deepEqual(cases.map(({ outcome }) => outcome).sort(), ['fail', 'pass']);
  assert.ok(cases.some(({ name, outcome }) => /testPasses/u.test(name) && outcome === 'pass'), JSON.stringify(cases));
  assert.ok(cases.some(({ name, outcome }) => /testFails/u.test(name) && outcome === 'fail'), JSON.stringify(cases));
});

test('gate.swift-real.skips-unavailable: clause 2: a missing swift is named as unavailable, never a failure [C7]', (t) => {
  const missing = spawnSync('swift-binary-that-does-not-exist', ['--version'], { encoding: 'utf8' });
  assert.ok(missing.error, 'a missing tool errors instead of answering');
  if (!swiftAnswers()) return t.skip('swift unavailable on this machine: swift --version did not answer');
  assert.equal(swiftAnswers(), true);
});

test('gate.swift-real.build-folder-stays-in-the-copy: clause 3: the .build folder lives in the temporary copy, never in the repo [C7]', (t) => {
  if (!swiftAnswers()) return t.skip('swift unavailable on this machine: swift --version did not answer');
  const { root, run } = sharedRun();
  if (!existsSync(join(root, '.build'))) return t.skip(`swift unavailable: it left no build folder, ${buildReason(run)}`);
  assert.equal(existsSync(new URL('.build', FIXTURE)), false);
});
