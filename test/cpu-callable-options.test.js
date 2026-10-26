/** Callable evidence must not hide executable options in another binding [C7]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuLoadOptionsIn } from '../src/module-imports.js';

for (const [kind, statement] of [
  ['object binding', "{ const { callback } = opaque; test('pending', callback); }"],
  ['array binding', "{ const [callback] = opaque; test('pending', callback); }"],
  ['destructuring assignment', "({ callback } = opaque); test('pending', callback);"],
]) test(`a ${kind} cannot inherit another callback's callable evidence [C7]`, () => {
  const source = `import test from 'node:test'; function callback() {} ${statement}`;
  assert.equal(cpuLoadOptionsIn([source])[0], true,
    'an opaque options value remains conservative despite another function with the same spelling');
});

test('an unshadowed function callback has no CPU options [C7]', () => {
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

test('an unmodified callable alias works with automatic semicolon insertion [C7]', () => {
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

test('a proven string title and callable callback do not become CPU options [C7]', () => {
  for (const title of ["'ordinary'", 'heading']) {
    const source = `import test from 'node:test'; const heading = 'ordinary'; function execute() {} test(${title}, execute);`;
    assert.equal(cpuLoadOptionsIn([source])[0], false);
  }
});
