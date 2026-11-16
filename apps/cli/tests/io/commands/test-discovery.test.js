/** @pullboard-test-input source-cell apps/cli packages/runners */
/** Test the CI-like test runner's discovery and name-pattern selection against a copied runner [C7, S13]. */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { runChildTests } from '../../../../../packages/gate/tests/fixtures/child-tests.js';
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
} from '../../fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importsIn } from '../../../../../packages/gate/index.js';
import { commandDocs } from '../../../src/io/docs.js';
import { readTestOutcomes } from '../../../../../packages/gate/index.js';

/** Copy the runner and its transitive local imports without evaluating their code. */
function copyRunnerImports(sourceRoot, root) {
  const copied = new Set();
  // The source-owned catalog validates its actual command files without importing them.
  let pending = ['apps/cli/src/io/run/tests.js', ...commandDocs(sourceRoot).map(entry => `apps/cli/src/io/commands/${entry.name.split(' ')[0]}.js`)];
  while (pending.length) {
    const files = [...new Set(pending)].filter((file) => !copied.has(file));
    pending = [];
    if (!files.length) continue;
    // Imported JSON is leaf data, not an ES module for V8 to parse.
    const sources = files.map((file) => file.endsWith('.json') ? 'export {};' : readFileSync(join(sourceRoot, file), 'utf8'));
    const imports = importsIn(sources);
    for (const [index, file] of files.entries()) {
      copied.add(file);
      for (const request of imports[index]) {
        if (!request.startsWith('./') && !request.startsWith('../')) continue;
        const target = relative(sourceRoot, resolve(sourceRoot, dirname(file), request));
        assert.ok(target && target !== '..' && !target.startsWith('..' + sep) && !isAbsolute(target),
          `runner fixture import must stay in its source checkout: ${request}`);
        pending.push(target);
      }
      pending.push(...declaredRunnerModules(sources[index], sourceRoot));
    }
  }
  copyPackageFiles(sourceRoot, root, { files: [...copied] });
  return copied;
}

/** Expand leading module-load declarations for runtime-discovered runner modules, while excluding optional reporters. */
function declaredRunnerModules(source, sourceRoot) {
  const header = [];
  let inBlock = false;
  for (const line of source.split(/\r?\n/u)) {
    const text = line.trim();
    if (inBlock) {
      header.push(line);
      if (text.includes('*/')) inBlock = false;
      continue;
    }
    if (!text || text.startsWith('//')) { header.push(line); continue; }
    if (text.startsWith('/*')) {
      header.push(line);
      inBlock = !text.slice(2).includes('*/');
      continue;
    }
    break;
  }
  const declarations = header.map((line) => /^\/\*\* @pullboard-module-loads (.+?) \*\/$/u.exec(line.trim()))
    .filter(Boolean).flatMap((match) => match[1].trim().split(/\s+/u));
  const found = [];
  for (const declaration of declarations) {
    // The runner's `**` declaration covers user-selected custom reporters; this fixture supplies none.
    if (declaration === '**') continue;
    assert.ok(declaration.endsWith('.js'), `runner fixture module declaration must name JavaScript modules: ${declaration}`);
    const normalized = resolve(sourceRoot, declaration);
    const relativePath = relative(sourceRoot, normalized);
    assert.ok(relativePath && relativePath !== '..' && !relativePath.startsWith('..' + sep) && !isAbsolute(relativePath),
      `runner fixture module declaration must stay in its source checkout: ${declaration}`);
    assert.ok(!/[{}\[\]]/u.test(declaration), `runner fixture module declaration has unsupported glob syntax: ${declaration}`);
    const segments = declaration.split('/');
    const startCount = found.length;
    /** Walk one declared path glob without evaluating loaded source. */
    function walk(directory, index, prefix) {
      const segment = segments[index];
      if (segment === '**') {
        walk(directory, index + 1, prefix);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(directory, entry.name), index, prefix ? `${prefix}/${entry.name}` : entry.name);
        }
        return;
      }
      const pattern = new RegExp(`^${segment.replace(/[.+^$()|\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')}$`, 'u');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!pattern.test(entry.name)) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (index === segments.length - 1) {
          if (entry.isFile() && entry.name.endsWith('.js')) found.push(path);
        } else if (entry.isDirectory()) walk(join(directory, entry.name), index + 1, path);
      }
    }
    walk(sourceRoot, 0, '');
    assert.ok(found.length > startCount, `runner fixture module declaration must match files: ${declaration}`);
  }
  return found;
}

/** Build the runner-discovery fixture from a source checkout. */
function discoveryFixture(t, sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url))) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-discovery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  const runtime = join(root, 'node_modules', 'pullboard-runtime');
  mkdirSync(bin);
  mkdirSync(tests);
  mkdirSync(runtime, { recursive: true });
  // Keep runtime code outside Node's default test-file discovery while preserving package paths through symlinks.
  const shipped = copyPackageFiles(sourceRoot, runtime);
  const copied = copyRunnerImports(sourceRoot, runtime);
  // JavaScript stays limited to the actual import closure: pre-copying an undiscovered
  // dependency must never make the transitive-import test pass, or add real shipped tests.
  for (const file of shipped) {
    if (/\.[cm]?js$/u.test(file) && !copied.has(file)) rmSync(join(runtime, file));
  }
  symlinkSync(join(runtime, 'apps'), join(root, 'apps'), 'dir');
  symlinkSync(join(runtime, 'packages'), join(root, 'packages'), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const marker = join(root, 'ran-once');
  writeFileSync(join(tests, 'one.test.js'), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('one discovered test', () => appendFileSync(${JSON.stringify(marker)}, 'x'));
`);
  return { root, bin, marker };
}

/** Run default discovery and require exactly one fixture execution. */
function runDiscovery({ root, bin, marker }) {
  const result = runChildTests([], { cwd: root, args: ['--import', join(root, 'apps/cli/src/io/run/tests.js')] });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(readFileSync(marker, 'utf8'), 'x', 'one test ran exactly once under default discovery');
}

test('default discovery runs one fixture and does not recurse into the runner [C7, S13]', (t) => {
  runDiscovery(discoveryFixture(t));
});

test('discovery follows a new runner src import and its transitive dependency [C7, S13]', (t) => {
  const source = mkdtempSync(join(tmpdir(), 'pullboard-discovery-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(join(source, 'bin'));
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), source);
  const runner = readFileSync(join(source, 'apps/cli/src/io/run/tests.js'), 'utf8');
  writeFileSync(join(source, 'apps/cli/src/io/run/tests.js'), runner.replace('\n', "\nimport './discovery-extra.js';\n"));
  writeFileSync(join(source, 'apps/cli/src/io/run/discovery-extra.js'), "import { value } from './discovery-nested.js';\nif (value !== 'closure') throw new Error('transitive import failed');\n");
  writeFileSync(join(source, 'apps/cli/src/io/run/discovery-nested.js'), "export const value = 'closure';\n");
  writeFileSync(join(source, 'apps/cli/src/io/run/unreferenced.test.js'),
    "throw new Error('an unreferenced shipped test must stay outside the discovery fixture');\n");
  runDiscovery(discoveryFixture(t, source));
});


test('a name pattern that matches no test fails with NO_TESTS_MATCHED [C7,S13]', (t) => {
  const box = discoveryFixture(t);
  const runner = realpathSync(join(box.root, 'apps/cli/src/io/run/tests.js'));
  const file = join(box.root, 'test/one.test.js');
  const id = '12345678-1234-1234-1234-123456789abc';
  const env = { ...process.env };
  env.PULLBOARD_TIMING_RUN_ID = id;
  delete env.NODE_TEST_CONTEXT;
  /** Execute the copied real runner with fixture inputs and preserve its native output. */
  const execute = (...args) => spawnSync(process.execPath, [runner, ...args], { cwd: box.root, env, encoding: 'utf8' });
  const missing = execute('--test-name-pattern', 'no matching case 1018', file);
  assert.notEqual(missing.status, 0, `${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /NO_TESTS_MATCHED/u);
  assert.match(missing.stderr, /no matching case 1018/u);
  assert.ok(missing.stderr.includes(file), missing.stderr);
  assert.equal(existsSync(box.marker), false, 'a nonmatching case never executes');
  const matched = execute(file, '--test-name-pattern=one discovered test');
  assert.equal(matched.status, 0, `${matched.stdout}${matched.stderr}`);
  assert.equal(readFileSync(box.marker, 'utf8'), 'x');
  const whole = execute(file);
  assert.equal(whole.status, 0, `${whole.stdout}${whole.stderr}`);
  assert.equal(readFileSync(box.marker, 'utf8'), 'xx', 'whole-file behavior is preserved');
  const silent = join(box.root, 'silent.mjs');
  writeFileSync(silent, 'export default async function* (events) { for await (const event of events) {} }\n');
  const quietMissing = execute('--test-reporter', silent, '--test-name-pattern', 'another absent case 1018', file);
  assert.notEqual(quietMissing.status, 0, `${quietMissing.stdout}${quietMissing.stderr}`);
  assert.match(quietMissing.stderr, /NO_TESTS_MATCHED/u);
  const quietMatch = execute('--test-reporter', silent, '--test-name-pattern', 'one discovered test', file);
  assert.equal(quietMatch.status, 0, `${quietMatch.stdout}${quietMatch.stderr}`);
  assert.equal(quietMatch.stdout, '', 'observing selection adds no public reporter output');
  assert.ok(readTestOutcomes(quietMatch.stdout + quietMatch.stderr, id)?.length, 'captured output retains authenticated native outcomes');
  assert.equal(readFileSync(box.marker, 'utf8'), 'xxx');
  const output = join(box.root, 'default-reporter.tap');
  const defaultDestination = execute('--test-name-pattern', 'one discovered test',
    '--test-reporter-destination', output, file);
  assert.equal(defaultDestination.status, 0, `${defaultDestination.stdout}${defaultDestination.stderr}`);
  assert.match(readFileSync(output, 'utf8'), /ok 1 - one discovered test/u);
  assert.equal(readFileSync(box.marker, 'utf8'), 'xxxx');
  const absentWithDestination = execute('--test-reporter-destination=' + output,
    '--test-name-pattern=absent default reporter case 1018', file);
  assert.notEqual(absentWithDestination.status, 0, `${absentWithDestination.stdout}${absentWithDestination.stderr}`);
  assert.match(absentWithDestination.stderr, /NO_TESTS_MATCHED/u);
});


test('a name pattern that matches no test fails with NO_TESTS_MATCHED in a landing [C7,S13]', (t) => {
  const box = discoveryFixture(t);
  const runner = realpathSync(join(box.root, 'apps/cli/src/io/run/tests.js'));
  const file = join(box.root, 'test/one.test.js');
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1' };
  delete env.NODE_TEST_CONTEXT;
  /** Exercise the real landing API and its independent reporter on private files. */
  const execute = (...args) => spawnSync(process.execPath, [runner, ...args], { cwd: box.root, env, encoding: 'utf8' });
  const missing = execute('--test-name-pattern=absent landing case 1018', file);
  assert.notEqual(missing.status, 0, `${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /NO_TESTS_MATCHED/u);
  assert.equal(existsSync(box.marker), false);
  const silent = join(box.root, 'silent.mjs');
  const output = join(box.root, 'selected-output.txt');
  writeFileSync(silent, 'export default async function* (events) { for await (const event of events) {} }\n');
  const matched = execute('--test-reporter', silent, '--test-reporter-destination', output,
    '--test-name-pattern', 'one discovered test', file);
  assert.equal(matched.status, 0, `${matched.stdout}${matched.stderr}`);
  assert.equal(readFileSync(output, 'utf8'), '', 'the selected reporter destination stays silent');
  assert.equal(readFileSync(box.marker, 'utf8'), 'x');
});


test('runner option values that resemble a name pattern remain values [C7,S13]', (t) => {
  const box = discoveryFixture(t);
  const empty = join(box.root, 'test/empty.test.js');
  writeFileSync(empty, 'export {};\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [realpathSync(join(box.root, 'apps/cli/src/io/run/tests.js')),
    '--test-skip-pattern', '--test-name-pattern=absent option value 1018', empty],
  { cwd: box.root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stderr, /NO_TESTS_MATCHED/u, 'a skip-regex value is not a name-filter option');
});


test('a name pattern with sharded discovery keeps its filter [C7,S13]', (t) => {
  const box = discoveryFixture(t);
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify({ landingShards: 2 }));
  writeFileSync(join(box.root, '.gitignore'), 'ran-once\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: box.root });
  execFileSync('git', ['add', 'test/one.test.js', 'pullboard.json', '.gitignore'], { cwd: box.root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'test: seed tracked discovery case'], { cwd: box.root });
  const env = { ...process.env, PULLBOARD_LANDING_RUN: '1' };
  delete env.NODE_TEST_CONTEXT;
  /** Exercise configured discovery without explicit files, so the landing-shard branch is reached. */
  const execute = (pattern) => spawnSync(process.execPath, [realpathSync(join(box.root, 'apps/cli/src/io/run/tests.js')),
    '--test-name-pattern', pattern], { cwd: box.root, env, encoding: 'utf8' });
  const present = execute('one discovered test');
  assert.equal(present.status, 0, `${present.stdout}${present.stderr}`);
  assert.equal(readFileSync(box.marker, 'utf8'), 'x', 'the real configured shard is a positive control');
  const absent = execute('absent sharded case 1018');
  assert.notEqual(absent.status, 0, `${absent.stdout}${absent.stderr}`);
  assert.match(absent.stderr, /NO_TESTS_MATCHED/u, `${absent.stdout}${absent.stderr}`);
  assert.equal(readFileSync(box.marker, 'utf8'), 'x', 'a discarded filter must not run the tracked case again');
});
