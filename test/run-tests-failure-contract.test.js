/** @pullboard-test-input source-tree */
/** The real test runner's red output always parses into a complete failure account [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { privateFixtureFiles, runFixtureChild as spawnSync } from './fixture-child.js';
import { tapFailures } from '../packages/landing/index.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

/** Run the real runner on a fixture holding one failing and one passing case, and return its exact output. */
function runRedFixture() {
  const files = privateFixtureFiles('pullboard-run-tests-contract-');
  const { root } = files;
  files.write('package.json', JSON.stringify({ type: 'module' }));
  const fixture = join(root, 'contract.test.js');
  files.write('contract.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('contract passing case', () => {});
test('contract failing case', () => { assert.equal(1, 2); });
`);
  const result = spawnSync(process.execPath, [runner, fixture], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
  return { root, result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('a failing fixture run through the real runner parses to a complete account naming exactly that case [C7]', () => {
  const { root, result, output } = runRedFixture();
  assert.equal(result.status, 1, output);
  const account = tapFailures(output, root);
  assert.ok(account, `the gate's failure parser returned no account for the runner's output:\n${output}`);
  assert.deepEqual(account.map(row => row.name), ['contract failing case']);
});

test('every line the runner prints after the TAP count is accepted by the parser [C7]', () => {
  const { root, output } = runRedFixture();
  const lines = output.split('\n');
  const summary = lines.findLastIndex(line => /^# fail \d+\s*$/u.test(line));
  assert.ok(summary >= 0, `the runner printed no TAP failure count:\n${output}`);
  if (tapFailures(output, root) !== null) return;
  // Name the offending line: the first trailing line whose removal makes the account complete.
  const culprit = lines.slice(summary + 1).find((line, index, rest) => {
    const without = [...lines.slice(0, summary + 1), ...rest.filter((_, other) => other !== index)].join('\n');
    return line.trim() && tapFailures(without, root) !== null;
  });
  assert.fail(`the parser refuses a line the runner prints after the TAP count: ${JSON.stringify(culprit ?? '(several lines)')}`);
});
