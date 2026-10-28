/** Bounded compile-only binding proof never executes candidate source or weakens shadow uncertainty [C7,CD62]. */
/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { lex } from '../packages/kernel/index.js';
import { bindingReadsForModules } from '../src/cell-binding-uses.js';
import { fixtureSourceEdits } from '../bin/cells-move-fixtures.js';

const IMPORT = "import { join } from 'node:path';\n";

/** Hide only this actual import declaration, just as the production callers do; every other spelling stays visible. */
function proof(body) {
  const source = IMPORT + body;
  const scanned = lex(source).code;
  const probeBody = ' '.repeat(IMPORT.length - 1) + '\n' + scanned.slice(IMPORT.length);
  return bindingReadsForModules([{ file: 'fixture.js', source, body: probeBody, bindings: [{ local: 'join' }] }]).get('fixture.js').get('join');
}

/** Produce enough real expression calls to exceed the old full-source variant budget without any candidate evaluation. */
function manyCalls() {
  return Array.from({ length: 300 }, (_, index) => `const output${index} = join(root, 'leaf-${index}');`).join('\n');
}

test('actual api-http fixture config reads resolve without changing their source or move proof [C7]', () => {
  const source = readFileSync(new URL('./api-http.test.js', import.meta.url), 'utf8');
  const result = fixtureSourceEdits(source, { file: 'test/api-http.test.js',
    moves: [['src/git.js', 'packages/git/src/shell/git.js']] });
  assert.deepEqual(result, { edits: [], problems: [] });
});

test('many expression calls avoid variants while distant parameters and destructuring still invalidate binding identity [C7]', () => {
  const calls = manyCalls();
  const direct = proof(calls + "\nthrow new Error('candidate source must never execute');\n");
  assert.equal(direct.opaque, null);
  assert.equal(direct.potentialShadow, false);
  assert.equal(direct.reads.length, 300);
  for (const shadow of ['function nested(join) { return join; }',
    'function nested({ join }) { return join; }', 'try {} catch (join) {}',
    'function nested() { const join = () => 1; return join(); }',
    'join = () => 1;', '({ join } = replacement);']) {
    const row = proof(calls + '\n' + shadow);
    assert.ok(row.potentialShadow || row.opaque, 'the distant lexical declaration still receives the original compiler probes');
  }
});

test('193 ambiguous spellings retain the original per-binding budget refusal [C7]', () => {
  const row = proof(Array.from({ length: 193 }, () => 'const value = { join: 1 };').map((line, index) => line.replace('value', `value${index}`)).join('\n'));
  assert.equal(row.opaque, 'binding analysis complexity budget exceeded');
});

test('properties, methods, optional calls and newline-return fields never become lexical call proofs [C7]', () => {
  for (const source of ['const object = { join() {} };', 'class C { join() {} }',
    'class C { return\njoin() {} }', 'class C { return /*\n*/ join() {} }',
    'const object = {}; object.join();', 'const object = {}; object?.join();']) {
    const row = proof(source);
    assert.equal(row.reads.length, 0, source);
  }
  const optional = proof('join?.();');
  assert.ok(optional.reads.length || optional.opaque, 'optional invocation retains its original compile-only classification');
});

test('uncertain regex lines retain probes across every physical ECMAScript line boundary [C7]', () => {
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    for (const regex of ['/(join())/', '/=join()/', '/=>join()/']) {
      const row = proof(`if (true) ${regex}.test('');${separator}const harmless = 1;`);
      assert.ok(row.opaque || row.reads.length === 0, 'regex text cannot prove the imported function is called');
    }
  }
  const divided = proof('const value = 1 / join(2);');
  assert.ok(divided.reads.length || divided.opaque, 'division remains the original compiler decision');
});

test('original modules must compile even when every apparent use could take the lexical path [C7]', () => {
  for (const source of ['const value = join(1); const =', 'const value = join(1); let join;']) {
    const row = proof(source);
    assert.equal(row.reads.length, 0);
    assert.equal(row.opaque, 'original module does not compile within the source budget');
  }
});
