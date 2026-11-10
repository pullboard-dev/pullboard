/** One-file diagnosis retains the complete sanitized failure and rejects ambiguous selection [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

test('clause 1: diagnose runs one file and prints its full failure and repository frame [C7]', { timeout: 180_000 }, t => { // budget: one real test run on a runner.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  delete box.env.NODE_TEST_CONTEXT; // The fixture starts an independent Node test runner.
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  const long = 'diagnostic-' + 'x'.repeat(1800) + '-end';
  writeFileSync(join(box.repo, 'test/fail.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('failure', () => assert.fail(${JSON.stringify(long)}));\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: diagnostic fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const result = box.run(box.web, 'test', 'test/fail.test.js', '--diagnose', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  const output = JSON.parse(result.out).output;
  assert.ok(output.includes(long), 'failure is not truncated');
  assert.match(output, /test\/fail\.test\.js:\d+:\d+/u, 'the repository frame is retained');
  const ambiguous = box.run(box.web, 'test', 'test/fail.test.js', 'test/fail.test.js', '--diagnose', '--json');
  assert.equal(ambiguous.code, 1);
  assert.equal(JSON.parse(ambiguous.out).error.code, 'USAGE');
});
