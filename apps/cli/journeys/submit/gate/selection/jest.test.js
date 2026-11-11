/** @pullboard-test-input source-tree */
/**
 * A jest project submits with its own gate, and affectedTests and submitInvariants are validated [V4,C7].
 */
import {
  appendFileSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { configFromSource } from '../../../../../../packages/config/index.js';
import { privateRepo } from '../../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../../tests/fixtures/submit/gate.js';
import { put } from '../../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../../tests/fixtures/submit/gate.js';

test('a jest project submits with its own gate [V4,C7]', (t) => {
  for (const optedIn of [false, true]) {
    let box = privateRepo(t);
    const gateMarker = join(box.dir, `jest-gate-${optedIn}.log`);
    const testMarker = join(box.dir, `jest-tests-${optedIn}.log`);
    box.env.JEST_GATE_MARKER = gateMarker;
    box.env.JEST_TEST_MARKER = testMarker;
    if (optedIn) box.env.FAIL_UNSELECTED = '1';
    put(box.root, 'pullboard.json', JSON.stringify({
      gate: 'npm test',
      ...(optedIn ? { affectedTests: 'node test/jest-runner.js' } : {}),
    }));
    put(box.root, 'package.json', JSON.stringify({
      type: 'module',
      scripts: { test: 'node test/jest-runner.js' },
    }));
    put(box.root, 'src/a.js', 'export const value = 1;\n');
    put(box.root, 'src/b.js', 'export const value = 8;\n');
    put(box.root, 'test/jest-runner.js', [
      "import { appendFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['./test/a.test.js', './test/b.test.js'];",
      "appendFileSync(process.env.JEST_GATE_MARKER, process.argv.slice(2).length ? 'prefix\\n' : 'full\\n');",
      'const pending = [];',
      "globalThis.describe = (_name, run) => run();",
      "globalThis.it = (_name, run) => pending.push(Promise.resolve().then(run));",
      "globalThis.expect = actual => ({ toBe(expected) { if (!Object.is(actual, expected)) throw new Error(`expected ${expected}, received ${actual}`); } });",
      'for (const file of files) await import(pathToFileURL(resolve(file)));',
      'const results = await Promise.allSettled(pending);',
      'const failed = results.find(result => result.status === \'rejected\');',
      'if (failed) { console.error(failed.reason); process.exitCode = 1; }',
    ].join('\n') + '\n');
    put(box.root, 'test/a.test.js', [
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/a.js';",
      "describe('relative ESM imports', () => it('runs with jest-style globals', () => {",
      "  appendFileSync(process.env.JEST_TEST_MARKER, 'a\\n');",
      '  expect(value).toBe(2);',
      '}));',
    ].join('\n') + '\n');
    put(box.root, 'test/b.test.js', [
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/b.js';",
      "describe('relative ESM imports', () => it('runs the other configured test', () => {",
      "  if (process.env.FAIL_UNSELECTED) throw new Error('unselected test ran');",
      "  appendFileSync(process.env.JEST_TEST_MARKER, 'b\\n');",
      '  expect(value).toBe(8);',
      '}));',
    ].join('\n') + '\n');
    commitAll(box);
    box = builderRepo(box);
    const added = box.coordinator('add', 'build', 'Jest-style project', '--check', 'true');
    assert.equal(added.code, 0, added.err);
    assert.equal(box.run('claim', '1').code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): change a jest project source [G1]');

    const submitted = box.run('submit', '1', '--json');
    assert.equal(submitted.code, 0, submitted.err || submitted.out);
    const receipt = JSON.parse(submitted.out);
    if (optedIn) {
      assert.equal(receipt.gate.full, false);
      assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
      assert.equal(readFileSync(gateMarker, 'utf8'), 'prefix\n', 'the configured prefix ran the selected file');
      assert.equal(readFileSync(testMarker, 'utf8'), 'a\n', 'the unrelated test did not run');
    } else {
      assert.equal(receipt.gate.full, true);
      assert.equal(readFileSync(gateMarker, 'utf8'), 'full\n', 'the configured project gate ran without opt-in');
      assert.equal(readFileSync(testMarker, 'utf8'), 'a\nb\n', 'the full project gate ran both tests');
    }
  }
});

test('affectedTests accepts only a nonempty command prefix [V4,C7]', () => {
  for (const affectedTests of ['', '  ', 4, false, null]) {
    assert.throws(() => configFromSource(JSON.stringify({ affectedTests })), {
      code: 'BAD_CONFIG', message: /affectedTests.*nonempty command prefix/u,
    });
  }
  assert.equal(configFromSource(JSON.stringify({ affectedTests: 'node test/runner.js' })).affectedTests, 'node test/runner.js');
  assert.equal(configFromSource(JSON.stringify({ submitGate: 'landing' })).submitGate, 'landing');
  assert.throws(() => configFromSource(JSON.stringify({ submitGate: 'submit' })), {
    code: 'BAD_CONFIG', message: /submitGate.*landing/u,
  });
});

test('submitInvariants names literal project files and requires its explicit runner [V4,C7]', () => {
  assert.deepEqual(configFromSource('{}').submitInvariants, []);
  for (const submitInvariants of [null, 'test/a.test.js', [false], [''], ['../outside.test.js'], ['/outside.test.js'], ['C:/outside.test.js'], ['test/../a.test.js'], ['test/a.test.js\n'], ['test//a.test.js']]) {
    assert.throws(() => configFromSource(JSON.stringify({ affectedTests: 'pytest', submitInvariants })), { code: 'BAD_CONFIG', message: /submitInvariants/u });
  }
  assert.throws(() => configFromSource(JSON.stringify({ submitInvariants: ['tests/guard.py'] })), { code: 'BAD_CONFIG', message: /requires.*affectedTests/u });
  assert.deepEqual(configFromSource(JSON.stringify({ affectedTests: 'pytest', submitInvariants: ['tests/guard.py'] })).submitInvariants, ['tests/guard.py']);
});
