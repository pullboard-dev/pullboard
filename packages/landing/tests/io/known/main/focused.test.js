/** Focused main comparisons preserve named failures and use a complete file verdict only as a fallback [B3,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';
import { compareMainFailures } from '../../../../index.js';
import { failureSignatures } from '../../../../index.js';
import { matchingMainFailures } from '../../../../index.js';

const TARGET = 'apps/cli/journeys/exit/rules.test.js';

/** A complete TAP record remains a case-level match against the same focused main file. */
test('a focused red main run yields a matching named failure account [B3,C7]', () => {
  const root = join(import.meta.dirname, '../../../../../..');
  const output = [
    'TAP version 13', 'not ok 1 - inherited case [B3]', '  ---',
    `  location: ${root}/test/inherited.test.js:1:1`,
    '  failureType: testCodeFailure', "  error: 'assertion failed'", '  ...',
    '1..1', '# tests 1', '# pass 0', '# fail 1', '# cancelled 0', '',
  ].join('\n');
  const failures = failureSignatures({ isGreen: false, executionRoot: root,
    stages: [{ status: 1, output }] }, root, { raw: true });
  assert.equal(failures?.length, 1);
  const comparison = { main: 'a'.repeat(40), files: [{ file: 'test/inherited.test.js', result: 'red', failures,
    signatureVersion: 1 }] };
  assert.ok(matchingMainFailures(failures, comparison, comparison.main));
});

/** The exact file-red fallback is permitted only for a complete isolated main execution. */
test('an incomplete named account falls back to a complete per-file isolation verdict [B3,C7]', () => {
  const main = 'a'.repeat(40);
  const candidate = { file: TARGET, name: 'candidate case', signature: 'b'.repeat(64) };
  const comparison = { main, files: [{ file: TARGET, result: 'red', fileIsolation: true }] };
  assert.ok(matchingMainFailures([candidate], comparison, main));
  assert.equal(matchingMainFailures([candidate], { main, files: [{ file: TARGET, result: 'green', fileIsolation: true }] }, main), null);
});

/** A committed main with one named red, built once: the comparison path is the claim, so a one-case file stands in for the journey. */
function redMain() {
  const dir = privateFixtureFiles('pullboard-focused-main-');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Focused', GIT_AUTHOR_EMAIL: 'focused@example.invalid',
    GIT_COMMITTER_NAME: 'Focused', GIT_COMMITTER_EMAIL: 'focused@example.invalid' };
  for (const key of Object.keys(env)) if (/^PULLBOARD_(GATE|BROWSER|TEST|LANDING)_/u.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_TEST_CONTEXT') delete env[key];
  dir.write('package.json', JSON.stringify({ private: true, type: 'module' }) + '\n');
  dir.write('pullboard.json', JSON.stringify({ gate: 'node test/runner.js', affectedTests: 'node test/runner.js' }) + '\n');
  dir.write(TARGET, "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('exit rules stand-in stays red [B3]', () => assert.equal(1, 2));\n");
  dir.write('test/runner.js', "import { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });\nprocess.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exitCode = r.status ?? 1;\n");
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'test: a pinned named main failure']]) runFixtureGit(args, { cwd: dir.root, env });
  return { root: dir.root, commit: runFixtureGit(['rev-parse', 'HEAD'], { cwd: dir.root, env }).trim(), env };
}

/** The main red is checked at an exact committed main and retained as either named or isolated evidence. */
test('exit-rules on main is recorded as a known red by the focused comparison [B3,C7]', { timeout: 240_000 }, async t => {
  const main = redMain();
  t.after(() => rmSync(main.root, { recursive: true, force: true }));
  assert.ok(main.commit, 'the focused comparison pins a committed main');
  const comparison = await compareMainFailures(main.root, { tests: [{ file: TARGET, passed: false }] }, undefined, '', {
    commit: main.commit, detailed: true, fresh: true, allowCancelled: true,
  });
  assert.equal(comparison.unavailable, undefined, comparison.unavailable);
  const row = comparison.files.find(value => value.file === TARGET);
  // The file is red only while main's own source breaks it; once main repairs it the comparison is green and excuses nothing.
  if (row?.result === 'green') return assert.deepEqual(row.failures ?? [], [], 'a green main file carries no failure to excuse');
  assert.equal(row?.result, 'red');
  assert.ok(row.fileIsolation === true || Array.isArray(row.failures) && row.failures.length > 0,
    'the main red carries a named account or the complete isolated file verdict');
  const failure = row.failures?.[0] ?? { file: TARGET, name: 'isolated main case', signature: 'c'.repeat(64) };
  assert.ok(matchingMainFailures([failure], comparison, main.commit), 'known-main comparison matches the main red');
});
