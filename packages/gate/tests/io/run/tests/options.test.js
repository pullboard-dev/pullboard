/** Options the production runner cannot apply are refused by name, wherever they appear [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../../fixtures/child.js';

const runner = fileURLToPath(new URL('../../../../../../apps/cli/src/io/run/tests.js', import.meta.url));

test('gate.io-run-tests-options.an-unknown-option-after-the-file: an unknown option after the file is refused by name [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-unknown-option-after-')); try {
    writeFileSync(join(root, 'option.test.mjs'), "import { test } from 'node:test';\ntest('a case runs', () => {});\n");
    const result = runFixtureChild(process.execPath, [runner, 'option.test.mjs', '--foo'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'an option the runner cannot apply must not exit green');
    assert.match(`${result.stdout}${result.stderr}`, /run-tests: unknown option --foo/u, 'the refusal names the option');
    assert.doesNotMatch(result.stdout, /a case runs/u, 'the file does not run silently');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate.io-run-tests-options.test-only-after-the-file-is: --test-only after the file is refused by name [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-only-after-')); try {
    writeFileSync(join(root, 'only.test.mjs'), "import { test } from 'node:test';\ntest('a case runs', () => {});\n");
    const result = runFixtureChild(process.execPath, [runner, 'only.test.mjs', '--test-only'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'an option the runner does not apply must not exit green');
    assert.match(`${result.stdout}${result.stderr}`, /run-tests: unknown option --test-only/u, 'the refusal names the option');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A two-case file; each case says its own name when it runs. */
function twoCaseFile(name) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-skip-after-')); try {
    writeFileSync(join(root, name), "import { test } from 'node:test';\ntest('alpha case runs', () => {});\ntest('beta case runs', () => {});\n");
    return { root, runSkip: (args) => runFixtureChild(process.execPath, [runner, name, ...args], { cwd: root, encoding: 'utf8' }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test('gate.io-run-tests-options.a-skip-pattern-after-the-file: a skip pattern after the file in the equals form runs only the other case [C7]', () => {
  const fixture = twoCaseFile('skip-equals.test.mjs');
  try {
    const result = fixture.runSkip(['--test-skip-pattern=alpha']);
    assert.equal(result.status, 0, result.context);
    assert.match(result.stdout, /beta case runs/u, 'the unskipped case runs');
    assert.doesNotMatch(result.stdout, /alpha case runs/u, 'the skipped case does not run');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('gate.io-run-tests-options.a-skip-pattern-after-the-file-2: a skip pattern after the file in the separate-value form runs only the other case [C7]', () => {
  const fixture = twoCaseFile('skip-separate.test.mjs');
  try {
    const result = fixture.runSkip(['--test-skip-pattern', 'alpha']);
    assert.equal(result.status, 0, result.context);
    assert.match(result.stdout, /beta case runs/u, 'the unskipped case runs');
    assert.doesNotMatch(result.stdout, /alpha case runs/u, 'the skipped case does not run');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
