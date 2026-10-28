/** Bounded compile-only binding proof never executes candidate source or weakens shadow uncertainty [C7,CD62]. */
/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from './fixture-child.js';
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

/** Read exact regular committed producer bytes from this source-only test checkout, never machine state. */
function sourceSnapshot(file) {
  return { source: readFileSync(new URL('../' + file, import.meta.url), 'utf8'),
    object: runFixtureGit(['rev-parse', `HEAD:${file}`], { cwd: fileURLToPath(new URL('../', import.meta.url)) }) };
}

test('actual api-http fixture config reads resolve without changing their source or move proof [C7]', () => {
  const source = readFileSync(new URL('./api-http.test.js', import.meta.url), 'utf8');
  const result = fixtureSourceEdits(source, { file: 'test/api-http.test.js',
    moves: [['src/git.js', 'packages/git/src/shell/git.js']], readSource: sourceSnapshot });
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
  assert.equal(proof('const values = [...join];').reads.length, 1, 'spread still reads the imported binding');
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

/** Use the production recognizer with actual imported readers and module-relative moved paths. */
function recognize(body) {
  const source = "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" + body;
  return fixtureSourceEdits(source, { file: 'test/scopes.test.js', moves: [['src/moved.js', 'packages/git/src/shell/moved.js']] });
}

test('repeated constants resolve only in their unique containing lexical scope [C7]', () => {
  const result = recognize(`function first() {
    const input = join(import.meta.dirname, '../src/moved.js'); readFileSync(input);
  }
  function second() {
    const input = join(import.meta.dirname, '../config.json'); readFileSync(input);
  }`);
  assert.deepEqual(result.problems, []);
  assert.equal(result.edits.length, 1);
  assert.match(result.edits[0].text, /packages\/git\/src\/shell\/moved\.js/u);
  for (const body of [
    `function outer() { const input = join(import.meta.dirname, '../src/moved.js');
      function inner(input) { readFileSync(input); } }`,
    `function outer() { const input = join(import.meta.dirname, '../src/moved.js');
      input = unknown; readFileSync(input); }`,
    `function outer() { if (flag) { const input = join(import.meta.dirname, '../src/moved.js'); }
      readFileSync(input); }`,
    `function outer() { const input = join(import.meta.dirname, '../config.json');
      { readFileSync(input); const input = join(import.meta.dirname, '../src/moved.js'); } }`,
    `function outer() { switch (flag) { case 0: const input = join(import.meta.dirname, '../src/moved.js');
      break; case 1: readFileSync(input); } }`,
    `function outer() {\nconst input = 'src/moved.js';\nif(true) /{const input='safe.json';/.test('');\nreadFileSync(input);\n}`,
  ]) {
    const uncertain = recognize(body);
    assert.deepEqual(uncertain.edits, []);
    assert.ok(uncertain.problems.length, 'shadows, writes, mixed branches and TDZ remain unsupported');
  }
});

/** Represent one immutable Git blob, as the production snapshot readers do. */
function blob(source) {
  return { source, object: createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex') };
}

test('imported producers need exact source identity and a proven native join return leaf [C7]', () => {
  const consumer = "import { readFileSync } from 'node:fs';\nimport { locate as local } from '../src/producer.js';\nreadFileSync(local());";
  const valid = "import { join } from 'node:path';\nexport function locate() { return join(unknownRoot, 'config.json'); }\n";
  const options = { file: 'test/producer.test.js', moves: [['src/moved.js', 'packages/git/src/shell/moved.js']] };
  const inspect = readSource => fixtureSourceEdits(consumer, { ...options, readSource });
  assert.deepEqual(inspect(file => { assert.equal(file, 'src/producer.js'); return blob(valid); }), { edits: [], problems: [] });
  const unrelated = valid + "export async function configure() { return await import('./setup.js'); }\n";
  assert.deepEqual(inspect(() => blob(unrelated)), { edits: [], problems: [] }, 'unrelated dynamic source loading cannot change the proven producer return');
  const changed = valid.replace('config.json', 'moved.js');
  const uncertain = [undefined, () => null,
    () => blob(valid.replace('return join', "return import('./setup.js') || join")),
    () => blob(valid + "export function configure() { return require('./setup.js'); }\n"), () => ({ source: valid, object: '0'.repeat(40) }),
    () => blob(changed), () => blob(valid + "locate = () => 'src/moved.js';\n"),
    () => blob(valid.replace('return join', 'return untrusted')),
    () => blob(valid.replace("'config.json'", '`' + '${unknown}' + '`')),
    () => blob(valid.replace('return join', "const join = untrusted; return join")),
    () => blob("import * as path from 'node:path';\nexport function locate() { return path.join(root, 'config.json'); }\npath.join = untrusted;\n")];
  for (const readSource of uncertain) {
    const result = inspect(readSource);
    assert.deepEqual(result.edits, []);
    assert.ok(result.problems.length, 'absent, changed, shadowed or ambiguous producer evidence stays unsupported');
  }
  let calls = 0;
  assert.ok(inspect(() => blob(calls++ ? changed : valid)).problems.length, 'source mutation during analysis is refused');
});
