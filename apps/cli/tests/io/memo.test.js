/** @pullboard-test-input apps/cli/src/io/memo.js packages/codemap/src/io/cells/scripts/cache.js packages/gate/index.js packages/items/index.js packages/landing/index.js */
/** Runners share one cells fixture-analysis memo through the controller; a bad memo never replaces good entries [C7]. */
/** @pullboard-world-pin: the runner fixture carries the shipped memo-share module, the code a pinned main's archive holds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize } from 'node:v8';
import { serialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { absorbFixtureMemo } from '../../src/io/memo.js';
import { controllerMemoStore } from '../../src/io/memo.js';
import { keepRunnerFixtureMemo } from '../../src/io/memo.js';
import { runnerFixtureMemos } from '../../src/io/memo.js';
import { remoteSubmitAnalysis } from '../../src/io/submit/gate.js';
import { temporaryDirectory } from '../fixtures/board.js';
import { temporaryRepository } from '../fixtures/board/submit.js';
import { privateFixtureFiles } from '../fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';

const NAME = `${'a'.repeat(64)}.v8.gz`;

/** A memo file's bytes holding the given keys, each with one recorded read and a serialized result. */
function memoBytes(keys, tag = 'result') {
  return gzipSync(serialize({ version: 1, entries: new Map(keys.map(key => [key, { reads: [['test/a.js', 'b'.repeat(40)]], result: serialize({ tag, key }) }])) }));
}

/** The keys and result tags of the memo stored under NAME in a folder. */
function stored(directory) {
  const data = deserialize(gunzipSync(readFileSync(join(directory, NAME))));
  return Object.fromEntries([...data.entries].map(([key, value]) => [key, deserialize(value.result).tag]));
}

/** A private folder removed after the test. */
function folder(t, prefix) {
  const files = privateFixtureFiles(prefix);
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  return files.root;
}

test('clause 1: an absorbed memo is copied, then unioned with later memos while stored entries win [C7]', t => {
  const directory = folder(t, 'fixture-memo-store-');
  assert.equal(absorbFixtureMemo(directory, { name: NAME, data: memoBytes(['one', 'two'], 'first').toString('base64') }), true);
  assert.deepEqual(stored(directory), { one: 'first', two: 'first' });
  assert.equal(absorbFixtureMemo(directory, { name: NAME, data: memoBytes(['two', 'three'], 'second').toString('base64') }), true);
  assert.deepEqual(stored(directory), { one: 'first', two: 'first', three: 'second' });
  assert.equal(absorbFixtureMemo(directory, { name: NAME, data: memoBytes(['one'], 'third').toString('base64') }), false, 'nothing new changes nothing');
});

test('clause 2: a malformed, oversized or misnamed memo is ignored and never replaces good entries [C7]', t => {
  const directory = folder(t, 'fixture-memo-bad-');
  absorbFixtureMemo(directory, { name: NAME, data: memoBytes(['good']).toString('base64') });
  const bad = [
    { name: 'notes.v8.gz', data: memoBytes(['x']).toString('base64') },
    { name: `../${NAME}`, data: memoBytes(['x']).toString('base64') },
    { name: NAME, data: Buffer.from('not a memo').toString('base64') },
    { name: NAME, data: gzipSync(serialize({ version: 2, entries: new Map([['x', { reads: [], result: Buffer.alloc(1) }]]) })).toString('base64') },
    { name: NAME, data: gzipSync(serialize({ version: 1, entries: new Map([['x', { reads: 'no', result: Buffer.alloc(1) }]]) })).toString('base64') },
    { name: NAME, data: 'A'.repeat(33 * 1024 ** 2) },
    null,
  ];
  for (const memo of bad) assert.equal(absorbFixtureMemo(directory, memo), false);
  assert.deepEqual(stored(directory), { good: 'result' });
});

test('clause 1: a runner seeds its memo from carried memos, and the controller keeps what a job returns [C7]', t => {
  const runner = folder(t, 'fixture-memo-runner-'), controller = folder(t, 'fixture-memo-controller-');
  const memos = runnerFixtureMemos({ cellsCacheDirectory: kind => join(runner, kind) }, [{ name: NAME, data: memoBytes(['carried']).toString('base64') }]);
  assert.deepEqual(stored(join(runner, 'fixtures')), { carried: 'result' });
  const value = { cells: [], fixtureMemo: memos.collect() };
  keepRunnerFixtureMemo(value, controller);
  assert.equal('fixtureMemo' in value, false, 'the memo never stays in the recorded result');
  assert.deepEqual(stored(controller), { carried: 'result' });
  assert.equal(runnerFixtureMemos({}, []), null, 'a main without a cells cache shares nothing');
  const home = folder(t, 'fixture-memo-home-');
  assert.equal(controllerMemoStore({ PULLBOARD_MACHINE_HOME: home }), join(home, 'cells-cache', 'fixtures-shared'));
});

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/** A controller whose main carries the real memo-share module, and runner clones whose cells caches are their own folders. */
function fixture(t) {
  const dir = temporaryDirectory('fixture-memo-share-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'fixture-memo-share-controller-');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('apps/cli/src/io/memo.js', readFileSync(fileURLToPath(new URL('../../src/io/memo.js', import.meta.url)), 'utf8'));
  put('packages/items/index.js', 'export function requirePlannedSource() {}\nexport function requireSubmitComposition() {}\n');
  put('packages/gate/index.js', `export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) { return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', 'export async function requireSubmitCells(root, main, source) { return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n');
  put('packages/codemap/src/io/cells/scripts/cache.js', `import { join } from 'node:path';
export function transferredCellsInventories() { return null; }
export function cellsCacheDirectory(kind) { return join(process.env.FIXTURE_RUNNER_CACHE, kind); }
`);
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'main');
  const main = git(controller, 'rev-parse', 'HEAD');
  put('src/thing.js', 'export const thing = 1;\n');
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate');
  const source = git(controller, 'rev-parse', 'HEAD');
  const runners = ['first', 'second'].map(name => {
    const root = join(dir, name);
    git(dir, 'clone', '--quiet', '--no-checkout', controller, root);
    git(root, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source);
    return { root, cache: join(dir, `${name}-cache`) };
  });
  return { dir, controller, runners, main, source, env, tree: git(controller, 'rev-parse', `${source}^{tree}`) };
}

/** A runner transport that runs the private check in one runner clone, with that runner's own cells cache. */
function lease(box, runner, commands = []) {
  const runOnRunnerAsync = async (_root, shell, options) => {
    commands.push({ shell, artifact: options.analysisArtifact ?? null });
    let bytes;
    try { bytes = execFileSync('/bin/sh', ['-c', shell], { cwd: runner.root, env: { ...box.env, FIXTURE_RUNNER_CACHE: runner.cache }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 ** 2 }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256 } } } } };
  };
  return { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree }, executionServices: { runners: { runOnRunnerAsync } } };
}

test('clause 1: one runner\'s memo reaches the controller store, and no request carries memo bytes [C7]', async t => {
  const box = fixture(t), home = folder(t, 'fixture-memo-machine-');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  const [first, second] = box.runners;
  mkdirSync(join(first.cache, 'fixtures'), { recursive: true });
  writeFileSync(join(first.cache, 'fixtures', NAME), memoBytes(['built-on-first']));
  const request = { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    staticChecks: '', config: { affectedTests: 'node packages/gate/src/io/run/tests.js' }, browserFreeChecks: true, readCutItems: () => [], perPart: true };
  const one = await remoteSubmitAnalysis(box.controller, request, lease(box, first), join(box.dir, 'one'));
  assert.equal('fixtureMemo' in one, false);
  assert.deepEqual(stored(join(home, 'cells-cache', 'fixtures-shared')), { 'built-on-first': 'result' });
  assert.equal(existsSync(join(second.cache, 'fixtures', NAME)), false);
  const commands = [];
  await remoteSubmitAnalysis(box.controller, { ...request, source: box.source }, lease(box, second, commands), join(box.dir, 'two'));
  // The memos ride only in the analysis artifact (#4054); this fixture has no accepted inventory bundle to carry them.
  assert.equal(commands.length, 1);
  assert.ok(commands[0].shell.length < 256 * 1024, `the request command is ${commands[0].shell.length} bytes`);
  assert.equal(commands[0].shell.includes(memoBytes(['built-on-first']).toString('base64').slice(0, 64)), false, 'no memo bytes in the command');
});
