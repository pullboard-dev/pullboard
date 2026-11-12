/** @pullboard-test-input source-tree */
/** Test the CI-like test runner against real Git and PATH behavior [C7, S13]. */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { expandTestFolders } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  privateFixtureFiles,
  runFixtureChild as spawnSync,
} from '../../fixtures/child.js';
import {
  chmodSync,
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
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { importsIn } from '../../../../../packages/gate/index.js';
import { commandDocs } from '../../../src/io/docs.js';
import { readTestOutcomes } from '../../../../../packages/gate/index.js';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { runResident } from '../../../src/io/resident/client.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { withFixtureBoard } from '../../fixtures/testkit.js';

test('tests run without inherited Git identity or config and refuse ambient pullboard [C7, S13]', (t) => {
  assert.equal(process.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(process.env.GIT_CONFIG_COUNT, '3');
  assert.equal(process.env.GIT_CONFIG_KEY_0, 'user.useConfigOnly');
  assert.equal(process.env.GIT_CONFIG_VALUE_0, 'true');
  assert.equal(process.env.GIT_CONFIG_KEY_1, 'gc.auto');
  assert.equal(process.env.GIT_CONFIG_VALUE_1, '0');
  assert.equal(process.env.GIT_CONFIG_KEY_2, 'maintenance.auto');
  assert.equal(process.env.GIT_CONFIG_VALUE_2, 'false');
  assert.equal(process.env.GIT_AUTHOR_NAME, undefined);
  assert.equal(process.env.GIT_AUTHOR_EMAIL, undefined);
  assert.equal(process.env.GIT_COMMITTER_NAME, undefined);
  assert.equal(process.env.GIT_COMMITTER_EMAIL, undefined);
  assert.equal(process.env.SSH_CONNECTION, undefined);
  assert.equal(process.env.SSH_CLIENT, undefined);
  assert.equal(process.env.SSH_TTY, undefined);
  assert.equal(process.env.HOME, process.env.PULLBOARD_HOME);
  assert.ok(process.env.PULLBOARD_MACHINE_HOME.startsWith(join(process.env.TMPDIR, 'machine')));
  assert.ok(process.env.PULLBOARD_TEST_FILE.endsWith('apps/cli/tests/io/commands/test.test.js'));

  const root = mkdtempSync(join(tmpdir(), 'pullboard-runner-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const identity = spawnSync('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(identity.status, 0, 'Git refuses to infer an author identity from the machine');
  assert.match(identity.stderr, /author identity unknown/i);
  const autoGc = spawnSync('git', ['config', '--get', 'gc.auto'], { cwd: root, encoding: 'utf8' });
  const autoMaintenance = spawnSync('git', ['config', '--get', 'maintenance.auto'], { cwd: root, encoding: 'utf8' });
  assert.equal(autoGc.status, 0, autoGc.stderr);
  assert.equal(autoGc.stdout.trim(), '0');
  assert.equal(autoMaintenance.status, 0, autoMaintenance.stderr);
  assert.equal(autoMaintenance.stdout.trim(), 'false');

  const refused = spawnSync('pullboard', ['init'], { cwd: root, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /pullboard is not installed/);
  assert.match(refused.stderr, /apps\/cli\/tests\/io\/commands\/test\.test\.js/);

  const fixtureShims = join(root, 'fixture-bin');
  mkdirSync(fixtureShims);
  const fixture = join(fixtureShims, 'pullboard');
  writeFileSync(fixture, '#!/bin/sh\nprintf "fixture shim first\\n"\n');
  chmodSync(fixture, 0o755);
  const preferred = spawnSync('pullboard', ['init'], {
    cwd: root,
    env: { ...process.env, PATH: `${fixtureShims}${delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(preferred.status, 0);
  assert.match(preferred.stdout, /fixture shim first/);
});

test('runner removes its private home after test workers exit [C7, S13]', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-runner-cleanup-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const probe = join(scratch, 'runner-probe.test.js');
  const report = join(scratch, 'sandbox-path');
  writeFileSync(probe, `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('reports its sandbox and person-terminal markers', () => writeFileSync(${JSON.stringify(report)}, JSON.stringify({ sandbox: process.env.TMPDIR, ssh: [process.env.SSH_CONNECTION, process.env.SSH_CLIENT, process.env.SSH_TTY] })));
`);
  const runner = fileURLToPath(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url));
  const launchEnv = { ...process.env };
  Object.assign(launchEnv, {
    SSH_CONNECTION: '192.0.2.1 1234 192.0.2.2 22',
    SSH_CLIENT: '192.0.2.1 1234 22',
    SSH_TTY: '/dev/pts/4',
  });
  delete launchEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, probe], { encoding: 'utf8', env: launchEnv });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(existsSync(report), `${result.stdout}${result.stderr}`);
  const resultEnv = JSON.parse(readFileSync(report, 'utf8'));
  const sandbox = resultEnv.sandbox;
  assert.deepEqual(resultEnv.ssh, [null, null, null], 'the runner removes every SSH transport marker before test workers act as the person');
  assert.equal(existsSync(sandbox), false, 'the private sandbox is removed after Node exits');

  const failingProbe = join(scratch, 'runner-failure.test.js');
  writeFileSync(failingProbe, "import { test } from 'node:test';\ntest('fails', () => { throw new Error('forward this failure'); });\n");
  const failed = spawnSync(process.execPath, [runner, failingProbe], { encoding: 'utf8' });
  assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`);
  assert.match(failed.stdout, /forward this failure/);
});

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
  const launchEnv = { ...process.env };
  delete launchEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--import', join(root, 'apps/cli/src/io/run/tests.js')], {
    cwd: root,
    encoding: 'utf8',
    env: launchEnv,
  });
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

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A board with one queued test run whose detached worker is a stand-in that never starts. */
function queuedRunBoard() {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const commonDir = join(box.repo, '.git');
  const run = withFixtureBoard(join(commonDir, 'pullboard', 'board.sqlite'), board => queueTestRun({ info: { commonDir, root: box.repo } },
    work => work(board), { agent: 'seat', files: ['test/a.test.js'] }, { launch: () => ({ unref() {} }) }));
  return { box, run, commonDir };
}

test('clause 1: test --status prints the run state without spawning the resident board [C7,#5888]', async () => {
  const { box, run, commonDir } = queuedRunBoard();
  const env = { ...box.env, PULLBOARD_RESIDENT: '1' };
  const quiet = { write() { return true; }, isTTY: false };
  const started = [];
  const start = place => started.push(place);
  assert.equal(await runResident(['test', '--status', run.id], { cwd: box.repo, env, stdout: quiet, stderr: quiet, start }), null);
  assert.deepEqual(started, [], 'test --status with no resident process reads in-process and starts none');
  assert.equal(await runResident(['show', '1'], { cwd: box.repo, env, stdout: quiet, stderr: quiet, start }), null);
  assert.equal(started.length, 1, 'control: another resident command with no process does start one');
  const status = await box.inProcess(box.repo, 'test', '--status', run.id);
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  assert.match(status.out, new RegExp(`test run ${run.id} queued: test/a\\.test\\.js`, 'u'));
  const residents = readdirSync(join(commonDir, 'pullboard')).filter(name => name.startsWith('resident-'));
  assert.deepEqual(residents, [], 'no resident board process recorded itself');
});

test('clause 2: test --status of an unknown run id still refuses with a next step [C7,#5888]', async () => {
  const { box } = queuedRunBoard();
  const refused = await box.inProcess(box.repo, 'test', '--status', '00000000-0000-4000-8000-000000000000');
  assert.equal(refused.code, 1, `${refused.out}${refused.err}`);
  assert.match(refused.err, /\[NO_TEST_RUN\]/u);
  assert.match(refused.err, /^next: /mu);
});

test('pullboard test given a folder expands it to the test files under it, never ERR_UNSUPPORTED_DIR_IMPORT [C7,S13]', (t) => {
  const box = privateFixtureFiles('pullboard-test-folders-');
  const root = box.root;
  t.after(() => box.cleanup?.());
  for (const file of ['dir/b.test.js', 'dir/sub/a.test.js', 'dir/helper.js', 'empty/readme.txt']) box.write(file, 'export {};\n');
  assert.deepEqual(expandTestFolders(root, ['dir/', 'x.test.js']), ['dir/b.test.js', 'dir/sub/a.test.js', 'x.test.js']);
  assert.throws(() => expandTestFolders(root, ['empty']), (error) => error.code === 'NO_TEST_FILE' && /empty/u.test(error.message));
});
