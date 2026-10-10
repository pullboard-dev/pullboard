/** Keep the production runner's report stable across Node versions and caller options [C7]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from './fixture-child.js';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

/** Create a fixture that observes actual child arguments and returns the runner result. */
function runReporterFixture(t, reporterArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-run-tests-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'reporter.test.js');
  const preload = join(root, 'capture-args.mjs');
  const capture = join(root, 'child-args.json');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(fixture, "import { test } from 'node:test';\ntest('reporter fixture [C7]', () => {});\n");
  writeFileSync(preload, `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawnSync;
/** Record the runner's actual child argv before allowing the test process to start. */
cp.spawnSync = function captureNodeTestArgs(file, args, options) {
  if (String(file) === process.execPath && args?.includes('--test')) {
    fs.writeFileSync(process.env.PULLBOARD_REPORTER_CAPTURE_FILE, JSON.stringify(args));
  }
  return original.call(this, file, args, options);
};
syncBuiltinESMExports();
`);

  const result = spawnSync(process.execPath, [runner, ...reporterArgs, fixture], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import="${preload}"`,
      PULLBOARD_REPORTER_CAPTURE_FILE: capture,
    },
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const childArgs = JSON.parse(readFileSync(capture, 'utf8'));
  return { result, output, childArgs };
}

test('run-tests prints TAP on every Node version and keeps a caller reporter [C7]', (t) => {
  const defaultReporter = runReporterFixture(t);
  assert.equal(defaultReporter.result.status, 0, defaultReporter.output);
  assert.match(defaultReporter.output, /^TAP version \d+/mu);
  assert.match(defaultReporter.output, /^ok \d+ - reporter fixture \[C7\]/mu);
  assert.ok(defaultReporter.childArgs.includes('--test-reporter=tap'), 'the production child receives the explicit TAP reporter');

  const callerReporter = runReporterFixture(t, ['--test-reporter=spec']);
  assert.equal(callerReporter.result.status, 0, callerReporter.output);
  assert.ok(callerReporter.childArgs.includes('--test-reporter=spec'), 'the caller option reaches the production child');
  assert.ok(!callerReporter.childArgs.includes('--test-reporter=tap'), 'the default does not override a caller reporter');
  assert.doesNotMatch(callerReporter.output, /^TAP version \d+/mu);
  assert.match(callerReporter.output, /reporter fixture \[C7\]/u);

  const splitCallerReporter = runReporterFixture(t, ['--test-reporter', 'spec']);
  assert.equal(splitCallerReporter.result.status, 0, splitCallerReporter.output);
  const splitReporterIndex = splitCallerReporter.childArgs.indexOf('--test-reporter');
  assert.ok(splitReporterIndex >= 0, 'the separate reporter flag reaches the child');
  assert.equal(splitCallerReporter.childArgs[splitReporterIndex + 1], 'spec');
  assert.ok(!splitCallerReporter.childArgs.includes('--test-reporter=tap'), 'the default does not override the separate caller option');
  assert.doesNotMatch(splitCallerReporter.output, /^TAP version \d+/mu);
});

/** Run the actual runner with timing output and a caller reporter enabled. */
function runProfileReporterFixture(t, reporterArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-run-tests-profile-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'profile-reporter.test.js');
  const profileBase = join(root, 'profile');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(fixture, "import { test } from 'node:test';\ntest('profile reporter fixture [C7]', () => {});\n");
  const result = spawnSync(process.execPath, [runner, ...reporterArgs, fixture], {
    cwd: root,
    env: { ...process.env, PULLBOARD_TEST_TIMING_PROFILE: profileBase },
    encoding: 'utf8',
    timeout: 15_000,
  });
  const profileName = readdirSync(root).find((name) => name.startsWith('profile.'));
  const rawProfile = profileName ? readFileSync(join(root, profileName), 'utf8') : '';
  assert.match(rawProfile, /^\{"files":/u, 'the private destination receives timing JSON');
  const profile = JSON.parse(rawProfile);
  return { result, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, profile };
}

test('run-tests keeps caller reporter output visible beside a timing profile [C7]', (t) => {
  for (const reporterArgs of [
    ['--test-reporter=spec'],
    ['--test-reporter', 'spec'],
    ['--test-reporter=spec', '--test-reporter-destination=stdout'],
    ['--test-reporter', 'spec', '--test-reporter-destination', 'stdout'],
  ]) {
    const run = runProfileReporterFixture(t, reporterArgs);
    assert.equal(run.result.status, 0, run.output);
    assert.ok(run.profile, 'the timing profile is still written as JSON');
    assert.equal(run.profile.tests.length, 1);
    assert.equal(run.profile.tests[0].name, 'profile reporter fixture [C7]');
    assert.match(run.output, /ℹ tests 1/u, 'the caller’s spec reporter remains on stdout');
    assert.doesNotMatch(run.output, /^\{"files":/mu, 'profile JSON does not replace caller output');
  }
});
