/** Callable evidence must not hide executable options in another binding [C7]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuLoadOptionsIn } from '../../../../heavy.js';
import { testsNeedCpuRunner } from '../../../../src/io/admission/cpu/load.js';

test('gate.io-admission-cpu-load.batched-literals-retain-escaped-registration-and: batched literals retain escaped registration and option authority [C7]', () => {
  const sources = [
    String.raw`import { "t\u0065st" as register } from 'node:t\u0065st'; register('busy', { 'cpuL\u006fad': true }, () => {});`,
    String.raw`import test from 'node:test'; test('ordinary', { 'cpuL\u006fad': false }, () => {});`,
    String.raw`import { register } from './ordinary.js'; register('ordinary', { cpuLoad: true }, () => {});`,
  ];
  assert.deepEqual(cpuLoadOptionsIn(sources), [true, false, false]);
});

test('gate.io-admission-cpu-load.literal-cache-overflow-preserves-late-cpu: literal-cache overflow preserves late CPU options without executing source [C7]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cpu-literal-overflow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'executed');
  const fields = Array.from({ length: 1030 }, (_value, index) => `'metadata${index}': 0`).join(',');
  const prefix = `import test from 'node:test'; import { writeFileSync } from 'node:fs'; const metadata = { ${fields} }; writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  const sources = [
    `${prefix} test('busy', { 'cpuL\u006fad': true }, () => {});`,
    `${prefix} test('ordinary', { 'cpuL\u006fad': false }, () => {});`,
  ];
  assert.deepEqual(cpuLoadOptionsIn(sources), [true, false]);
  assert.equal(existsSync(marker), false);
});

for (const [kind, statement] of [
  ['object binding', "{ const { callback } = opaque; test('pending', callback); }"],
  ['array binding', "{ const [callback] = opaque; test('pending', callback); }"],
  ['destructuring assignment', "({ callback } = opaque); test('pending', callback);"],
]) test(`a ${kind} cannot inherit another callback's callable evidence [C7]`, () => {
  const source = `import test from 'node:test'; function callback() {} ${statement}`;
  assert.equal(cpuLoadOptionsIn([source])[0], true,
    'an opaque options value remains conservative despite another function with the same spelling');
});

test('gate.io-admission-cpu-load.an-unshadowed-function-callback-has-no: an unshadowed function callback has no CPU options [C7]', () => {
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; function callback() {} test('ordinary', callback);"])[0], false);
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; function callback() {} test('busy', { cpuLoad: true }, callback);"])[0], true,
    'proven callbacks cannot erase a genuine options argument');
});

for (const [kind, declarations, selected] of [
  ['single newline alias', 'const first = callback\n', 'first'],
  ['newline alias chain', 'const first = callback\nconst second = first\n', 'second'],
]) test(`a ${kind} retains opaque options after its source is reassigned [C7]`, () => {
  const source = `import test from 'node:test'; function callback() {} callback = makeOptions(); ${declarations}test('pending', ${selected});`;
  assert.equal(cpuLoadOptionsIn([source])[0], true,
    'automatic semicolon insertion cannot preserve invalidated callable evidence');
});

test('gate.io-admission-cpu-load.a-parameter-that-shadows-an-imported: clause 1: a parameter that shadows an imported test alias is not read as a registration [C7,#6900]', () => {
  const options = "('x', { cpuLoad: true }, () => {});";
  for (const [kind, body] of [
    ['function parameter', `function helper(test) { test${options} }`],
    ['arrow parameter', `const helper = (test) => { test${options} };`],
    ['bare arrow parameter', `const helper = test => { test${options} };`],
    ['destructured parameter', `function helper({ test }) { test${options} }`],
    ['defaulted parameter', `function helper(first, test = null) { test${options} }`],
    ['rest parameter', `function helper(...test) { test${options} }`],
    ['method parameter', `class Helper { run(test) { test${options} } }`],
    ['catch binding', `try {} catch (test) { test${options} }`],
  ]) assert.equal(cpuLoadOptionsIn([`import { test } from 'node:test'; ${body}`])[0], false, `${kind} hides the imported alias`);
  assert.equal(cpuLoadOptionsIn([`import { test as it } from 'node:test'; function helper(it) { it${options} }`])[0], false, 'a renamed alias is hidden too');
});

test('gate.io-admission-cpu-load.a-registration-outside-the-shadowing-function: clause 1: a registration outside the shadowing function, or one whose key only looks like the alias, stays a registration [C7,#6900]', () => {
  const options = "('x', { cpuLoad: true }, () => {});";
  for (const [kind, body] of [
    ['a later top-level call', `function helper(test) { return test; } test${options}`],
    ['an expression arrow then a call', `const helper = (test) => test('a', 1)\ntest${options}`],
    ['an unrelated parameter', `function helper(first, second) { test${options} }`],
    ['a renamed destructured key', `function helper({ test: other }) { test${options} }`],
    ['a subtest of a real registration', `test('outer', async t => { await t.test('inner', { cpuLoad: true }, () => {}); });`],
  ]) assert.equal(cpuLoadOptionsIn([`import { test } from 'node:test'; ${body}`])[0], true, `${kind} is still a registration`);
});

test('gate.io-admission-cpu-load.an-unmodified-callable-alias-works-with: an unmodified callable alias works with automatic semicolon insertion [C7]', () => {
  const source = "import test from 'node:test'; function callback() {} const first = callback\nconst second = first\ntest('ordinary', second);";
  assert.equal(cpuLoadOptionsIn([source])[0], false,
    'the fix retains a real callable alias without any CPU options');
});

for (const [kind, preparation, argument, expected] of [
  ['literal true options', '', '{ cpuLoad: true }', true],
  ['literal false options', '', '{ cpuLoad: false }', false],
  ['identifier true options', 'const configuration = { cpuLoad: true };', 'configuration', true],
  ['identifier false options', 'const configuration = { cpuLoad: false };', 'configuration', false],
]) test(`an omitted test name preserves ${kind} [C7]`, () => {
  const source = `import test from 'node:test'; const execute = async () => {}; ${preparation} test(${argument}, execute);`;
  assert.equal(cpuLoadOptionsIn([source])[0], expected,
    'the options-first overload keeps the declared load without inventing a test title');
});

test('gate.io-admission-cpu-load.a-proven-string-title-and-callable: a proven string title and callable callback do not become CPU options [C7]', () => {
  for (const title of ["'ordinary'", 'heading']) {
    const source = `import test from 'node:test'; const heading = 'ordinary'; function execute() {} test(${title}, execute);`;
    assert.equal(cpuLoadOptionsIn([source])[0], false);
  }
});

test('gate.io-admission-cpu-load.a-string-concatenated-title-is-a: a string-concatenated title is a title, while a conditional first argument stays conservative [C7,V4]', () => {
  // The landing-shards fixture names its case 'fixture file ' + name; that can only be a string.
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; const name = 'a'; test('fixture file ' + name, async () => {});"])[0], false);
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; test('case ' + name + ' at ' + (Date.now() % 7), () => {});"])[0], false);
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; test('x' + flag ? options : 'y', () => {});"])[0], true,
    'a top-level conditional could still pass an options object');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; test({ cpuLoad: true }, async () => {});"])[0], true);
});

test('gate.io-admission-cpu-load.batched-classification-preserves-exact-selected-files: batched classification preserves exact selected files across real registration graphs [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cpu-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'executed');
  const modules = {
    'registration.js': "export { test as register } from 'node:test'; export const execute = () => {};",
    'busy.test.js': String.raw`import { register, execute } from './registration.js'; register('busy', { 'cpuL\u006fad': true }, execute);`,
    'ordinary.test.js': "import { register, execute } from './registration.js'; register('ordinary', { cpuLoad: false }, execute);",
    'opaque.test.js': "import { register, execute } from './registration.js'; register('unknown', settings, execute);",
    'lookalike.test.js': "function register() {} register('ordinary', { cpuLoad: true }, () => {});",
    'data.test.js': "import test from 'node:test'; const metadata = { cpuLoad: true }; export { metadata };",
    'never-run.test.js': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  };
  for (const [file, source] of Object.entries(modules)) writeFileSync(join(directory, file), source);
  const files = Object.keys(modules).filter(file => file.endsWith('.test.js'));
  const selected = files.filter(file => testsNeedCpuRunner(directory, [file]));
  assert.deepEqual(selected, ['busy.test.js', 'opaque.test.js'], 'real CPU registrations and unresolved options retain the same selected files');
  assert.equal(testsNeedCpuRunner(directory, files), true);
  assert.equal(testsNeedCpuRunner(directory, files.filter(file => !selected.includes(file))), false);
  assert.equal(existsSync(marker), false, 'selection only reads source; fixture programs never execute');
});

test('gate.io-admission-cpu-load.cpu-options-continued-across-a-newline: clause 1: CPU options continued across a newline are read whole, not cut at the line end [C7,#6902]', () => {
  const head = "import test from 'node:test'; ";
  for (const value of ["'title'\n&& { cpuLoad: true }", "'title'\n  ?? { cpuLoad: true }", "flag\n&& { cpuLoad: true }", "{ cpuLoad: false }\n|| { cpuLoad: true }"]) {
    assert.equal(cpuLoadOptionsIn([`${head}const opts = ${value};\ntest(opts, () => {});`])[0], true, `${value} stays conservative`);
  }
  assert.equal(cpuLoadOptionsIn([`${head}const title = 'plain'\ntest(title, () => {});`])[0], false,
    'a title that ends at the newline is still a title');
});
