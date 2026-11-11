/** @pullboard-test-input source-tree */
/**
 * The package stays dependency-free (P3): nothing to install but Node, nothing in node_modules to
 * trust, and every import is a Node built-in or a file of its own.
 */
import assert from 'node:assert/strict';
import {
  startFixtureChild as spawn,
  runFixtureChild as spawnSync,
} from '../../../apps/cli/tests/fixtures/child.js';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { repoPath } from '../../kernel/light.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * A child Node that compiles each source from a regular file as an ES module and reports, for each, whether
 * it compiles and the modules it imports statically, as V8 lists them.
 */
const PARSER = [
  "import vm from 'node:vm';",
  "import { readFileSync } from 'node:fs';",
  "const sources = JSON.parse(readFileSync(process.argv[1], 'utf8'));",
  'const look = (source) => {',
  '  try {',
  '    const module = new vm.SourceTextModule(source);',
  '    return { compiles: true, imports: module.moduleRequests ? module.moduleRequests.map((request) => request.specifier) : module.dependencySpecifiers };',
  '  } catch {',
  '    return { compiles: false, imports: [] };',
  '  }',
  '};',
  'process.stdout.write(JSON.stringify(sources.map(look)));',
].join('\n');

/**
 * What V8 makes of each source, in one bounded child that never waits for stdin EOF.
 *
 * @param {string[]} sources
 * @returns {{ compiles: boolean, imports: string[] }[]}
 */
function look(sources) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-package-parser-'));
  try {
    const input = join(directory, 'sources.json');
    writeFileSync(input, JSON.stringify(sources), { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PARSER, input], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 2 ** 26,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every place the whole word import appears, in code or not; Unicode letters count as part of a word. */
const IMPORT = /(?<![\p{ID_Continue}$\u200c\u200d#])import(?![\p{ID_Continue}$\u200c\u200d])/gu;

/** Whitespace and comments, which may sit between import, its parenthesis and its argument. A line comment ends at any line terminator. */
const GAP = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/;

/** What a dynamic import of anything but a plain string loads: unknown, so never node: or relative. */
const COMPUTED = '(computed)';

/**
 * The text from `at` on, past whitespace and comments.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string}
 */
function pastGap(source, at) {
  const rest = source.slice(at);
  return rest.slice(GAP.exec(rest)[0].length);
}

/**
 * What an import(...) call at `at` loads: its argument when that is one plain string, decoded, or
 * COMPUTED for anything else, a string whose escapes do not decode included. Only called on words
 * V8 has confirmed are import calls in code.
 *
 * @param {string} source
 * @param {number} at
 * @returns {string}
 */
function dynamicAt(source, at) {
  const argument = pastGap(pastGap(source, at + 'import'.length), 1);
  const literal = /^(['"])(?:\\[\s\S]|(?!\1)[^\\\n\r])*\1/.exec(argument);
  if (!literal) return COMPUTED;
  const after = pastGap(argument, literal[0].length)[0];
  if (after !== ')' && after !== ',') return COMPUTED;
  try {
    return new Function(`return ${literal[0]};`)();
  } catch {
    return COMPUTED;
  }
}

/**
 * Every module each source imports. V8 lists the static ones: import and export-from statements and
 * side-effect imports. For each import followed by a parenthesis, V8 also decides two things: a NUL
 * put before the word breaks the module only when the word is code, not text in a string, template,
 * comment or regular expression; and putting 1 in its place still compiles only when the word is a
 * call, not a property name after a dot. Only then is the argument read, and an argument that is not
 * one plain string is reported as COMPUTED, which no rule allows. A method named import, in a class
 * or object, still reads as a call: the scan errs toward a false alarm, never a miss.
 *
 * @param {string[]} sources - Each one a module that compiles.
 * @returns {string[][]}
 */
function importsIn(sources) {
  const calls = sources.map((source) => [...source.matchAll(IMPORT)].map((match) => match.index).filter((at) => pastGap(source, at + 'import'.length)[0] === '('));
  const variants = sources.flatMap((source, index) =>
    calls[index].flatMap((at) => [`${source.slice(0, at)}\u0000${source.slice(at)}`, `${source.slice(0, at)}1${source.slice(at + 'import'.length)}`]),
  );
  const looks = look([...sources, ...variants]);
  let next = sources.length;
  return sources.map((source, index) => {
    assert.ok(looks[index].compiles, `does not compile as a module: ${source.slice(0, 80)}`);
    const dynamic = calls[index].filter(() => {
      const isCode = !looks[next].compiles;
      const isCall = looks[next + 1].compiles;
      next += 2;
      return isCode && isCall;
    });
    return [...looks[index].imports, ...dynamic.map((at) => dynamicAt(source, at))];
  });
}

test('no dependencies of any kind, and Node 22.13 or newer [P3]', () => {
  assert.equal(PACKAGE.dependencies, undefined);
  assert.equal(PACKAGE.devDependencies, undefined);
  assert.equal(PACKAGE.engines.node, '>=22.13');
});

test('npm metadata points to the official site and keeps GitHub project links [I12]', () => {
  assert.equal(PACKAGE.homepage, 'https://pullboard.dev');
  assert.equal(PACKAGE.repository.url, 'git+https://github.com/pullboard-dev/pullboard.git');
  assert.equal(PACKAGE.bugs.url, 'https://github.com/pullboard-dev/pullboard/issues');
});

test('the import scan finds a package however it is imported, and nothing that is not an import [P3]', () => {
  const forms = {
    "import pad from 'left-pad';": ['left-pad'],
    'import pad from "left-pad";': ['left-pad'],
    'import {\n  a,\n  b,\n} from "left-pad";': ['left-pad'],
    "export { a } from 'left-pad';": ['left-pad'],
    'export * from "left-pad";': ['left-pad'],
    "import 'left-pad';": ['left-pad'],
    'import "left-pad";': ['left-pad'],
    "const pad = await import('left-pad');": ['left-pad'],
    'const pad = await import( "left-pad" );': ['left-pad'],
    'import pad\n  from "left-pad";': ['left-pad'],
    "const pad = await import ('left-pad');": ['left-pad'],
    "const half = total / 2; const pad = await import('left-pad');": ['left-pad'],
    "const page = `${'a'} b`; const pad = await import('left-pad');": ['left-pad'],
    "const rule = 'the move starts from'; const next = 'x';": [],
    "// this rule comes from 'left-pad'": [],
    "/*\nimport fake from 'left-pad';\n*/": [],
    "const page = `\nimport fake from 'left-pad';\n`;": [],
    "const code = \"await import('left-pad')\";": [],
    "const quote = /'/g; const text = \"import fake from 'left-pad'\";": [],
    "export const FROM = 'from';": [],
    "const x = {a:1} / await import('left-pad') / 2;": ['left-pad'],
    'if (false) /import("left-pad")/.test("x");': [],
    "for (const key of keys) /'/.test(key); const text = \"import('left-pad')\";": [],
    "const half = count++ / 2; const pad = await import('left-pad');": ['left-pad'],
    "function f() {} /'/.test(x); const pad = await import('left-pad');": ['left-pad'],
    "const wrap = (a) => ({ b: a }) / 2; const pad = await import('left-pad');": ['left-pad'],
    'import "node:fs"; import "left-pad";': ['node:fs', 'left-pad'],
    'import fs from "node:fs"; import pad from "left-pad";': ['node:fs', 'left-pad'],
    'const f = function () {} / await import("left-pad");': ['left-pad'],
    'const C = class {} / await import("left-pad");': ['left-pad'],
    "import { \"a-b\" as ab } from 'left-pad';": ['left-pad'],
    "import data from './data.json' with { type: 'json' };": ['./data.json'],
    'const pad = await import /* why */ ("left-pad");': ['left-pad'],
    'const where = import.meta.url;': [],
    "const pattern = /import('left-pad')/u;": [],
    'export const b = 1;\nexport * from "left-pad";': ['left-pad'],
    'export { a } from "left-pad"; export const b = 1;': ['left-pad'],
    'import { "{" as brace } from "left-pad";': ['left-pad'],
    'import pad // note\u2028from "left-pad";': ['left-pad'],
    'import "node:fs"; import "node:fs";': ['node:fs'],
    'const pad = await import(("left-pad"));': ['(computed)'],
    'const pad = await import("left" + "-pad");': ['(computed)'],
    'const pad = await import("left\\u002dpad");': ['left-pad'],
    "const pad = await import(/* why */ 'left-pad' /* still */, { with: {} });": ['left-pad'],
    '// from import("\\u{110000}")': [],
    '// from import("\\xZZ")': [],
    'const caféimport = (x) => x; caféimport("left-pad");': [],
    'const obj = { import: (x) => x }; obj . import("left-pad"); obj?.import("left-pad");': [],
    '// Load it.\nimport("left-pad").then(() => {});': ['left-pad'],
    'const all = [...await import("left-pad")];': ['left-pad'],
    'function later() { return import("left-pad"); }': ['left-pad'],
    "function later() { return \"import('left-pad')\"; }": [],
  };
  const found = importsIn(Object.keys(forms));
  const set = (names) => [...new Set(names)].sort();
  Object.entries(forms).forEach(([source, expected], index) => assert.deepEqual(set(found[index]), set(expected), source));
});

/**
 * Every deliberate computed loader is declared here, by file and by its exact expression; an
 * undeclared computed import, or a declared file with a second one, still fails the scan. Two are
 * source-directory loaders that import a discovered file beneath their local URL; the rest load a
 * caller-selected module (a reporter, a tool, a worker port, a checker) or a guard at a runtime
 * path. Each declared expression is normalized to a relative import; recursively scanning their
 * leaves below keeps a package import in any discovered module visible to P3.
 */
const LOADERS = {
  'packages/moves/src/io/registry.js': ['import(new URL(file, directory).href)'],
  'apps/cli/src/io/commands/index.js': ['import(new URL(file, FOLDER).href)'],
  'apps/cli/src/io/submit/remote.js': ["import(existsSync(new URL('./apps/cli/src/io/cells-submit-checks.js', import.meta.url)) ? './apps/cli/src/io/cells-submit-checks.js' : './bin/cells-submit-checks.js')"],
  'apps/cli/src/io/submit/gate.js': ["import(existsSync(join(tools, 'apps/cli/src/io/cells-submit-checks.js')) ? './apps/cli/src/io/cells-submit-checks.js' : './bin/cells-submit-checks.js')", 'import(input.module)'],
  'apps/view/src/io/page/actions.js': ['import(configuredTransportModule)'],
  'packages/api/src/io/state/materializer/worker.js': ['import(workerData.portsModule)'],
  'packages/codemap/src/io/freeze.js': ['import(pathToFileURL(checker).href)'],
  'packages/doctrine/src/io/fast.js': ["import(pathToFileURL(join(root, 'packages/gate/src/io/scan.js')).href)", 'import(pathToFileURL(join(root, script)).href)'],
  'packages/gate/src/io/run-tests.js': ["import(reporter.startsWith('.') || reporter.startsWith('/')\n    ? pathToFileURL(resolve(reporter)).href : reporter)", 'import(moduleSpecifier)', 'import(guard.href)'],
};
function packageSource(file, source) {
  let text = source;
  for (const expression of LOADERS[file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file] ?? []) text = text.replace(expression, "import('./')");
  return text;
}

/** Parse one edited source control using exactly the package discovery policy. */
function importsForPackageFile(file, source) { return importsIn([packageSource(file, source)])[0]; }

test('every import is a node: built-in or a relative file [P3]', () => {
  const files = [join(ROOT, 'apps/cli/pullboard.js')];
  for (const group of ['apps', 'packages']) {
    for (const cell of readdirSync(join(ROOT, group))) {
      const source = join(ROOT, group, cell, 'src');
      if (!existsSync(source)) continue;
      files.push(...readdirSync(source, { recursive: true }).filter((name) => /\.m?js$/.test(name)).map((name) => repoPath(ROOT, `${group}/${cell}/src/${name}`)));
    }
  }
  const moveDirectory = join(ROOT, 'packages/moves/src/logic/moves');
  const moveFiles = readdirSync(moveDirectory).filter(name => name.endsWith('.js'));
  assert.ok(moveFiles.length > 0, 'all discovered move modules remain inside the no-dependencies scan');
  const found = importsIn(files.map(file => packageSource(file, readFileSync(file, 'utf8'))));
  files.forEach((file, index) => {
    for (const target of found[index]) assert.ok(target.startsWith('node:') || target.startsWith('.'), `${file} imports ${target}`);
  });
  const seen = found.flat().length;
  assert.ok(seen > 50, `the scan found ${seen} imports in apps and packages; expected every file's`);
});

test('discovery import normalization still exposes package imports and arbitrary computed targets [P3]', () => {
  const file = join(ROOT, 'packages/moves/src/io/registry.js');
  const source = readFileSync(file, 'utf8');
  const site = 'import(new URL(file, directory).href)';
  assert.ok(source.includes(site), 'the constrained discovery site is present');
  assert.ok(importsForPackageFile(file, source.replace(site, "import('left-pad')")).includes('left-pad'));
  assert.ok(importsForPackageFile(file, source.replace(site, 'import(otherTarget)')).includes(COMPUTED));
  assert.ok(importsForPackageFile(file, source + '\nvoid import(otherTarget);').includes(COMPUTED), 'a second computed import has no exemption');
  assert.ok(importsForPackageFile(join(ROOT, 'packages/moves/src/logic/moves/seed.js'), 'void import(otherTarget);').includes(COMPUTED), 'move leaves have no computed-import exemption');
});

test('the installable package includes the single inherited doctrine file [D1]', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  assert.equal(files.filter(file => file === 'packages/doctrine/src/io/standard.md').length, 1);
  assert.ok(files.includes('packages/doctrine/src/io/main.js'));
  assert.ok(files.includes('CHANGELOG.md'), 'resume release headlines require the shipped changelog');
});


test('the parser finishes without waiting for stdin EOF [C7,P3]', { timeout: 6000 }, async function parserWithoutStdinEOF() {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-parser-eof-guard-'));
  const input = join(directory, 'sources.json');
  writeFileSync(input, JSON.stringify(["import 'node:fs';"]), { mode: 0o600 });
  const child = spawn(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', PARSER, input], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 3000,
    killSignal: 'SIGKILL',
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    // Keep the writer open: reverting the parser to read fd 0 must hit the child bound.
    const [status, signal] = await once(child, 'close');
    assert.equal(status, 0, `parser depended on stdin EOF (${signal}): ${Buffer.concat(stderr)}`);
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString('utf8')), [{ compiles: true, imports: ['node:fs'] }]);
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});
