/** @pullboard-test-input source-tree */
/** Bounded compile-only binding proof never executes candidate source or weakens shadow uncertainty [C7,CD62]. */
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
  assert.equal(file, 'src/projects.js', 'this fixture supplies exactly its actual imported producer source');
  return { source: readFileSync(new URL('../src/projects.js', import.meta.url), 'utf8'),
    object: runFixtureGit(['rev-parse', 'HEAD:src/projects.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)) }) };
}

test('actual api-http fixture config reads resolve without changing their source or move proof [C7]', () => {
  assert.throws(() => sourceSnapshot('src/git.js'), /exactly its actual imported producer source/);
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


/** Recognize one explicit imported scalar input through the existing compiler identity proof. */
function binaryRead(source) {
  return fixtureSourceEdits("import { readFileSync } from 'node:fs';\n" + source,
    { file: 'test/binary.test.js', moves: [['src/leaf.js', 'packages/git/src/shell/leaf.js']] });
}

test('an explicit native executable scalar is disjoint while unknown and shadowed inputs refuse [C7]', () => {
  const imported = "import { execPath as binary } from 'node:process';\n";
  assert.deepEqual(binaryRead(imported + 'readFileSync(binary);'), { edits: [], problems: [] });
  for (const source of [imported + "function nested(binary) { readFileSync(binary); }",
    imported + "binary = 'src/leaf.js'; readFileSync(binary);",
    "import { argv as binary } from 'node:process'; readFileSync(binary);",
    "import { cwd as binary } from 'node:process'; readFileSync(binary());",
    "import process from 'node:process'; readFileSync(process.execPath);",
    "const process = { execPath: 'src/leaf.js' }; readFileSync(process.execPath);"]) {
    assert.ok(binaryRead(source).problems.length, 'unsupported native exports and uncertain binding identity stay unsupported');
  }
});

/** Analyze an actual native filesystem string argument with no candidate prefix evaluation. */
function suffixRead(expression, before = '') {
  return binaryRead("import { join, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n"
    + before + `\nreadFileSync(${expression});`);
}

test('only whole fixed string tails disjoint from every moved basename prove a source read [C7]', () => {
  for (const expression of ["prefix + '_unrelated.trace'", '`web/queue-${entry.id}.trace`',
    "join(root, prefix + '_unrelated.trace')", "(unknown()) + '_unrelated.trace'"]) {
    assert.deepEqual(suffixRead(expression), { edits: [], problems: [] });
  }
  for (const expression of ["prefix || other + '_unrelated.trace'", "prefix && other + '_unrelated.trace'",
    "prefix ?? other + '_unrelated.trace'", "prefix ? other : other + '_unrelated.trace'",
    "(prefix, other + '_unrelated.trace')", "selected = prefix + '_unrelated.trace'",
    "() => prefix + '_unrelated.trace'", "prefix + '_unrelated.trace' || other",
    "prefix + ''", "prefix + '.js'", "prefix + 'leaf.js'", "prefix + '.JS'",
    "prefix + '/unrelated.trace'", "prefix + '\\\\unrelated.trace'", "prefix + '\\ntrace'",
    '`web/${entry.id}.trace#x`', '`web/${entry.id}.trace?x`', '`web/${entry.id}.trace%20`',
    "new URL('../src/leaf.js#_unrelated.trace', import.meta.url)",
    "fileURLToPath(new URL('../src/leaf.js#_unrelated.trace', import.meta.url))",
    "new URL(`${entry.id}.trace`, import.meta.url)", "new URL(`${entry.id}.trace#x`, import.meta.url)",
    "fileURLToPath(new URL(`${entry.id}.trace`, import.meta.url))", "decodeURIComponent(prefix + '_unrelated.trace')",
    "resolve(root, prefix + '_unrelated.trace')", "join(root, prefix + '.js')", "prefix + 'unterminated"]) {
    assert.ok(suffixRead(expression).problems.length, 'branches, overlap, decoding and uncertain grammar stay unsupported: ' + expression);
  }
  assert.ok(fixtureSourceEdits("import { readFileSync } from 'node:fs'; readFileSync(prefix + '_unrelated.trace');",
    { file: 'test/suffix-overlap.js', moves: [['src/leaf.js', 'packages/git/src/shell/leaf.js'],
      ['src/other_unrelated.trace', 'packages/git/src/shell/other_unrelated.trace']] }).problems.length,
  'every moved basename participates in the disjointness proof');
  for (const [from, suffix] of [['src/café.js', '\u0301.js'], ['src/s.js', 'ſ.js'], ['src/ſ.js', 's.js'],
    ['src/café.js', '_unrelated.trace']]) {
    assert.ok(fixtureSourceEdits("import { readFileSync } from 'node:fs'; readFileSync(prefix + " + JSON.stringify(suffix) + ');',
      { file: 'test/suffix-unicode.js', moves: [[from, 'packages/git/src/shell/leaf.js']] }).problems.length,
    'Unicode normalization across the unknown prefix and full casefold uncertainty stay unsupported');
  }
  assert.ok(suffixRead("join(root, prefix + '_unrelated.trace')", 'function nested(join) {}').problems.length,
    'native callee shadowing still refuses the path operation');
  assert.ok(fixtureSourceEdits("import { cpSync } from 'node:fs'; cpSync(prefix + '_unrelated.trace', target, {recursive:true});",
    { file: 'test/suffix-directory.js', moves: [['src/leaf.js', 'packages/git/src/shell/leaf.js']] }).problems.length,
  'regular-file suffix proof never blesses a recursive directory copy');
});

/** Keep each real reader at its native source construction instead of trusting a returned object's mutable fields. */
function localPortSource(link, key) {
  return "import { readFileSync } from 'node:fs'; import { join } from 'node:path';\n"
    + `async function fixture() { const linkFile = ${link}; const keyFile = ${key};
      return { readLink() { return readFileSync(linkFile, 'utf8'); },
        readKey() { return readFileSync(keyFile, 'utf8'); } }; }`;
}

test('local fixture reader ports retain direct immutable source proof without async object trust [C7]', () => {
  const options = { file: 'test/local-readers.js', moves: [['src/leaf.js', 'packages/git/src/shell/leaf.js']] };
  assert.deepEqual(fixtureSourceEdits(localPortSource("join(root, '.git', 'pullboard', 'relay.json')",
    "join(home, 'keys', id + '.key')"), options), { edits: [], problems: [] });
  assert.ok(fixtureSourceEdits(localPortSource("join(root, '.git', 'pullboard', 'relay.json')",
    "join(home, 'keys', id + '.js')"), options).problems.length, 'a reader closure cannot hide a suffix overlapping moved source');
  for (const body of ["readFileSync(box.linkFile, 'utf8');",
    "async function read() { const box = await unknownConstructor(); return readFileSync(box.linkFile, 'utf8'); }"]) {
    assert.ok(fixtureSourceEdits("import { readFileSync } from 'node:fs'; " + body, options).problems.length,
      'unknown and asynchronous constructor fields never gain implicit source authority');
  }
});

test('copied source remains a move obligation while generated journals and recursive inventories stay explicit [C7]', () => {
  const options = { file: 'test/source-obligations.js', moves: [['src/leaf.js', 'packages/git/src/shell/leaf.js'],
    ['src/baseline.json', 'packages/git/src/shell/baseline.json']] };
  const source = "import { readFileSync, copyFileSync } from 'node:fs';\n"
    + "const original = readFileSync(new URL('../src/leaf.js', import.meta.url), 'utf8');\n"
    + "copyFileSync(new URL('../src/leaf.js', import.meta.url), new URL('../fixture/leaf.js', import.meta.url));";
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.problems, []);
  assert.equal(result.edits.length, 2, 'a copied source body remains an actual dependency, even in a private fixture');
  let rewritten = source;
  for (const edit of [...result.edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  assert.equal(rewritten.includes("new URL('../src/leaf.js', import.meta.url)"), false);
  assert.ok(rewritten.includes("new URL('../fixture/leaf.js', import.meta.url)"), 'the fixture destination is unchanged');
  const listed = fixtureSourceEdits("import { readFileSync } from 'node:fs';\n"
    + "for (const file of ['leaf.js']) readFileSync(new URL(`../src/${file}`, import.meta.url));", options);
  assert.deepEqual(listed.problems, []);
  assert.equal(listed.edits.length, 1, 'a finite declared source inventory carries its moved source operand');
  for (const body of ["readFileSync(join(directory, key + '.json'), 'utf8');",
    "readFileSync(join(root, failure.file));", "readFileSync(box.healthFile);",
    "const module = await import('../src/leaf.js'); readFileSync(module.input);",
    "for (const file of readdirSync(root, { recursive: true })) readFileSync(join(root, file));",
    "cpSync(box.keyFile, target);", "cpSync(join(box.root, '.git'), target, { recursive: true });"]) {
    const unresolved = fixtureSourceEdits("import { readFileSync, cpSync, readdirSync } from 'node:fs';\n"
      + "import { join } from 'node:path';\n" + body, options);
    assert.ok(unresolved.problems.length, 'an artifact name or private-root assumption cannot erase a possible source dependency: ' + body);
    assert.deepEqual(unresolved.edits, [], 'unknown source identity never creates a guessed rewrite');
  }
});

for (const [name, body] of [
  ['native JSON journal keys', "readFileSync(join(directory, key + '.json'), 'utf8');"],
  ['session and receipt path helpers', "readFileSync(checkoutSessionFile(repoInfo(root)), 'utf8'); readFileSync(join(receiptStore(root), receiptId + '.json'));"],
  ['scanned credentials and recursive copies', "for (const file of filesUnder(directory)) readFileSync(file); cpSync(join(box.root, '.git', 'pullboard'), target, { recursive: true });"],
  ['credential-store audit logs', "const keychainLog = setup.keychainLog; readFileSync(keychainLog, 'utf8');"],
]) test(`${name} remain named conservative obligations rather than successful artifact proofs [C7]`, () => {
  const source = "import { readFileSync, cpSync } from 'node:fs'; import { join } from 'node:path';\n" + body;
  const result = fixtureSourceEdits(source, { file: 'test/conservative-obligations.js',
    moves: [['src/leaf.js', 'packages/git/src/shell/leaf.js'], ['src/baseline.json', 'packages/git/src/shell/baseline.json']] });
  assert.ok(result.problems.length, 'unproved artifact provenance must remain visible');
  assert.ok(result.problems.every(problem => problem.startsWith('test/conservative-obligations.js:')
    && problem.includes('unsupported fixture source:')), 'every retained obligation names its actual source site');
  assert.deepEqual(result.edits, [], 'an unknown path never gains a guessed move or passing artifact classification');
});
