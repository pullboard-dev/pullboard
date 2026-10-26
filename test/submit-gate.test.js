/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/**
 * Submit proves its frozen item check and the import closure its change can reach; only a full
 * selection can stand in for the project gate, which still runs at landing [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { selectAffectedTests } from '../src/affected-tests.js';
import { configFromSource } from '../src/config.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import { refuseSandboxBlocked, sandboxBlockedOperation } from '../src/gate.js';
import { fileDenialWatcher } from '../src/sandbox-denial.js';

const BIN = resolveBin();
const dirs = [];
const SPEC = '# Submit proof fixture\n\n## G · Goals\n- G1 [approved, must] The selected test proves the change. | gate: test\n';

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Resolve the real CLI relative to this test without importing any project dependencies. */
function resolveBin() {
  return join(import.meta.dirname, '../bin/pullboard.js');
}

/** Create a private Git repository with a deterministic identity and isolated Pullboard home. */
function privateRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-gate-')));
  dirs.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  /** Run real Git in this fixture with only the fixture's configured identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Run the real local CLI, retaining JSON stdout and refusal stderr separately. */
  const run = (...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  git('init', '-q', '-b', 'main');
  assert.equal(run('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  put(root, 'SPEC.md', SPEC);
  put(root, 'package.json', '{"type":"module"}\n');
  return { dir, root, env, git, run };
}

/** Create a real joined builder while the coordinator stays on its unchanged trunk. */
function builderRepo(box) {
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { build: { owns: ['src/', 'test/'], specs: ['G'] } };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  commitAll(box);
  const made = box.run('worktree', 'build', '--json');
  assert.equal(made.code, 0, made.err);
  const root = JSON.parse(made.out).path;
  /** Run Git only in the joined builder. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  /** Run the real CLI with the joined builder identity. */
  const run = (...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  return { ...box, root, git, run, coordinator: box.run };
}

/** Write a fixture file, creating its parent directory when needed. */
function put(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Commit the fixture state using a valid Pullboard message. */
function commitAll(box, message = 'chore: fixture state') {
  box.git('add', '-A');
  box.git('commit', '-q', '-m', message);
  return box.git('rev-parse', 'HEAD');
}

/** Copy the real module graph in bounded commits while retaining every installed hook and secret scan. */
function copyRepositoryFixture(box, repository, tracked) {
  // New-file diffs add one prefix per line and small path headers. Leave half the real scan limit free.
  const batchBytes = 4 * 1024 * 1024;
  let stagedBytes = 0;
  let pending = false;
  let head;
  for (const path of tracked) {
    const source = readFileSync(join(repository, path), 'utf8');
    const estimate = Buffer.byteLength(source) + source.split('\n').length + 512 + 2 * Buffer.byteLength(path);
    assert.ok(estimate <= batchBytes, `one copied module exceeds the fixture batch limit: ${path}`);
    if (pending && stagedBytes + estimate > batchBytes) {
      head = commitAll(box); stagedBytes = 0; pending = false;
    }
    put(box.root, path, source);
    stagedBytes += estimate; pending = true;
  }
  return pending ? commitAll(box) : head;
}

/** Build a claimed submit fixture whose changed source selects a nested child-process test. */
function childFailureSubmitBox(t, testSource) {
  let box = privateRepo(t);
  // This fixture proves multiline TAP diagnostics; Node's default reporter varies by runtime.
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test --test-reporter=tap', affectedTests: 'node --test --test-reporter=tap', spec: 'SPEC.md' }));
  put(box.root, 'SPEC.md', SPEC);
  put(box.root, 'src/listener-probe.js', 'export const listenerProbe = 1;\n');
  put(box.root, 'test/listen-denial.js', [
    "import net from 'node:net';",
    "net.Server.prototype.listen = function deniedListen() {",
    "  const error = new Error('listen EPERM: operation not permitted 127.0.0.1:0');",
    "  Object.assign(error, { code: 'EPERM', syscall: 'listen', address: '127.0.0.1', port: 0 });",
    '  throw error;',
    '};',
  ].join('\n'));
  box.env.LISTEN_DENIAL_SHIM = join(box.root, 'test/listen-denial.js');
  put(box.root, 'test/child-listener.test.js', testSource);
  commitAll(box);
  box = builderRepo(box);
  const added = box.coordinator('add', 'build', 'Child-process gate fixture', '--check', 'true');
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/listener-probe.js', 'export const listenerProbe = 2;\n');
  commitAll(box, 'feat(core): change listener probe [G1]');
  return box;
}

/** Produce a real TAP failure containing a nested child's EPERM without relying on host sandbox support. */
function childListenerTestSource() {
  return [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import '../src/listener-probe.js';",
    "test('the server child binds', () => {",
    "  const child = spawnSync(process.execPath, ['--import', process.env.LISTEN_DENIAL_SHIM, '--input-type=module', '-e', \"import { createServer } from 'node:net'; createServer().listen(0, '127.0.0.1');\"], { encoding: 'utf8' });",
    "  assert.equal(child.status, 0, `App exited before listening (code ${child.status}, signal ${child.signal}):\\n${child.stderr}`);",
    '});',
  ].join('\n');
}

/** Produce a child-process test whose stderr models a Python traceback without requiring Python. */
function childPythonTestSource() {
  const childProgram = [
    'console.error("Traceback (most recent call last):")',
    'console.error("  File " + JSON.stringify("child.py") + ", line 1, in <module>")',
    'console.error("PermissionError: [Errno 13] Permission denied: " + JSON.stringify(process.env.CHILD_PERMISSION_PATH))',
    'process.exit(1)',
  ].join('\n');
  return [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import '../src/listener-probe.js';",
    "test('the child reports a Python-style denial', () => {",
    `  const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { encoding: 'utf8' });`,
    "  assert.equal(child.status, 0, `Child process exited with code ${child.status}:\\n${child.stderr}`);",
    '});',
  ].join('\n');
}

/** Format a standalone Python denial already recognized by the gate scanner. */
function pythonPermissionError(path, errno = 13) {
  return `PermissionError: [Errno ${errno}] Permission denied: '${path}'`;
}

/** Wrap scanner input in a failed child TAP record with or without a fatal traceback. */
function pythonChildTap(path, { traceback = true, frame = true, prefixMarker = false, errno = 13, wrapper = true, exitCode = 1, trailingError = false, assertionFooter = null, footerSeparator = '\n\n\n', parentCode = 'ERR_ASSERTION' } = {}) {
  const diagnostic = pythonPermissionError(path, errno);
  const marker = prefixMarker ? 'not a traceback marker: Traceback (most recent call last):' : 'Traceback (most recent call last):';
  const tracebackDetail = `${marker}\n${frame ? '  File "child.py", line 1, in <module>\n' : ''}${diagnostic}${trailingError ? '\nValueError: later unrelated failure' : ''}`;
  const detail = traceback ? tracebackDetail : `AssertionError: expected ordinary output\n${diagnostic}`;
  const renderedDetail = assertionFooter === null ? detail : `${detail}${footerSeparator}${assertionFooter}`;
  return [
    'TAP version 13',
    'not ok 1 - child reads a file',
    '  ---',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    ...(wrapper ? [`    Child process exited with code ${exitCode}:`] : []),
    ...renderedDetail.split('\n').map((line) => `    ${line}`),
    `  code: '${parentCode}'`,
    '  ...',
  ].join('\n');
}

test('a child process listen denial reads as sandbox blocked [C7,B26]', (t) => {
  const box = childFailureSubmitBox(t, childListenerTestSource());
  const result = box.run('submit', '1');
  const output = `${result.out}\n${result.err}`;
  assert.equal(result.code, 1, output);
  assert.match(output, /SANDBOX_BLOCKED/u, 'submit names the denied child-process listen');
  assert.match(output, /listen \(EPERM\)/u);
  assert.doesNotMatch(output, /GATE_RED/u);

  const explanatory = "  assert.equal(child.status, 0, `App exited before listening (code ${child.status}, signal ${child.signal}):\\n${child.stderr}`);";
  const original = childListenerTestSource();
  assert.equal(original.split(explanatory).length, 2, 'replace exactly one explanatory message');
  const bareSource = original.replace(explanatory, '  assert.equal(child.status, 0, child.stderr);');
  const bareBox = childFailureSubmitBox(t, bareSource);
  const bare = bareBox.run('submit', '1');
  const bareOutput = `${bare.out}\n${bare.err}`;
  assert.equal(bare.code, 1, bareOutput);
  assert.match(bareOutput, /SANDBOX_BLOCKED/u, 'bare stderr with structured fatal fields still names the denial');
  assert.match(bareOutput, /listen \(EPERM\)/u);
  assert.doesNotMatch(bareOutput, /GATE_RED/u);

  const pythonBox = childFailureSubmitBox(t, childPythonTestSource());
  pythonBox.env.CHILD_PERMISSION_PATH = join(pythonBox.dir, 'outside-python-denial.txt');
  const python = pythonBox.run('submit', '1');
  const pythonOutput = `${python.out}\n${python.err}`;
  assert.equal(python.code, 1, pythonOutput);
  assert.match(python.err, /SANDBOX_BLOCKED/u, 'submit names a scanner-known denial from a child traceback');
  assert.match(python.err, /file access .*\(EACCES\)/u);
  assert.match(python.err, /ask the coordinator to bring (?:it|this operation) to the person/iu);
  assert.match(python.err, /pullboard shout coordinator .*--decision/u);
  assert.doesNotMatch(python.err, /\bask the person\b/iu);
  assert.doesNotMatch(python.err, /GATE_RED/u);

  const pythonSource = childPythonTestSource();
  const pythonExplanation = "  assert.equal(child.status, 0, `Child process exited with code ${child.status}:\\n${child.stderr}`);";
  assert.equal(pythonSource.split(pythonExplanation).length - 1, 1, 'the bare Python counter changes exactly one parent message');
  const barePythonBox = childFailureSubmitBox(t, pythonSource.replace(pythonExplanation, '  assert.equal(child.status, 0, child.stderr);'));
  barePythonBox.env.CHILD_PERMISSION_PATH = join(barePythonBox.dir, 'outside-bare-python-denial.txt');
  const barePython = barePythonBox.run('submit', '1');
  const barePythonOutput = `${barePython.out}\n${barePython.err}`;
  assert.equal(barePython.code, 1, barePythonOutput);
  assert.match(barePython.err, /SANDBOX_BLOCKED/u, 'complete bare Python stderr still names the known denial');
  assert.match(barePython.err, /file access .*\(EACCES\)/u);
  assert.doesNotMatch(barePythonOutput, /GATE_RED/u);
});
/** A failed project command keeps its first diagnostic even when later output is unstructured. */
test('a red gate on submit shows what the gate said [C7,V10]', (t) => {
  for (const stream of ['log', 'error']) {
    let box = privateRepo(t);
    const first = stream === 'log' ? 'G1: merge main to get the missing row' : 'G1 error: commit cites it, but it was never committed to the spec';
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node test/gate-diagnostic.mjs', spec: 'SPEC.md', verify: 'any', lease: '2h' }));
    put(box.root, 'test/gate-diagnostic.mjs', [
      "import { existsSync } from 'node:fs';",
      "if (existsSync('src/RED')) {",
      `  console.${stream}(${JSON.stringify(first)});`,
      `  for (let n = 0; n < 80; n++) console.${stream}('detail ' + n + ': ' + 'x'.repeat(100));`,
      '  process.exit(1);',
      '}',
    ].join('\n'));
    commitAll(box);
    box = builderRepo(box);
    const added = box.coordinator('add', 'build', 'Show the gate diagnostic');
    assert.equal(added.code, 0, added.err);
    assert.equal(box.run('claim', '1').code, 0);
    put(box.root, 'src/RED', 'red\n');
    commitAll(box, 'feat(core): exercise gate output [G1]');
    const submitted = box.run('submit', '1', '--json');
    assert.notEqual(submitted.code, 0);
    const refusal = JSON.parse(submitted.out).error;
    assert.equal(refusal.code, 'GATE_RED');
    assert.ok(refusal.message.includes(first), 'the first diagnostic must survive the bounded refusal');
    assert.match(refusal.message, /\d+ nonempty output lines omitted/u);
    assert.ok(refusal.message.length < 5000, 'a refusal must remain bounded');
    const log = box.git('rev-parse', '--git-path', 'pullboard-submit.log').trim();
    const raw = readFileSync(resolve(box.root, log), 'utf8');
    assert.ok(raw.includes(first));
    assert.ok(raw.includes('detail 79:'), 'the complete gate output remains available in its log');
    assert.equal(JSON.parse(box.run('show', '1', '--json').out).item_status, 'claimed');
  }
});

test('an ordinary failure stays gate red [C7,B26]', (t) => {
  const source = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { listenerProbe } from '../src/listener-probe.js';",
    "test('ordinary failure', () => assert.equal(listenerProbe, 1));",
  ].join('\n');
  const box = childFailureSubmitBox(t, source);
  const outside = join(box.dir, 'outside-python-denial.txt');
  const direct = sandboxBlockedOperation(box.root, pythonPermissionError(outside));
  assert.equal(direct, `file access "${outside}" (EACCES)`, 'the standalone known denial remains recognized');
  assert.equal(sandboxBlockedOperation(box.root, pythonPermissionError(outside, 1)), `file access "${outside}" (EACCES)`,
    'the standalone EPERM-style Python errno remains recognized');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { traceback: false })), null,
    'permission-looking text without a fatal traceback stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(join(box.root, 'inside.txt'))), null,
    'an inside-root path stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside), { includeFilePaths: false }), null,
    'the no-file-paths option stays respected');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { frame: false })), null,
    'a traceback without a standard file frame stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { prefixMarker: true })), null,
    'traceback marker text inside a line is not a traceback');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { wrapper: false })), null,
    'a traceback without a failed child wrapper stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { exitCode: 0 })), null,
    'a zero-exit child is not a blocked failure');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { trailingError: true })), null,
    'a different terminal exception after PermissionError stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { errno: 1 })), `file access "${outside}" (EACCES)`,
    'a nested EPERM-style Python errno remains recognized');
  const recognized = `file access "${outside}" (EACCES)`;
  const streamed = fileDenialWatcher(box.root);
  const childTap = pythonChildTap(outside, { wrapper: false, assertionFooter: '1 !== 0' });
  const boundary = childTap.indexOf('PermissionError') + 5;
  streamed.push(Buffer.from(childTap.slice(0, boundary)));
  streamed.push(Buffer.from(childTap.slice(boundary)));
  assert.deepEqual(streamed.end(), { operation: 'file access', outside: true, errno: 'EACCES' },
    'the shared runner watcher retains structured evidence for a nested child denial across chunks');
  const ordinaryStream = fileDenialWatcher(box.root);
  ordinaryStream.push(Buffer.from(pythonChildTap(outside, { traceback: false, assertionFooter: '1 !== 0' })));
  assert.equal(ordinaryStream.end(), null, 'the runner watcher keeps ordinary permission-looking assertions ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '1 !== 0' })), recognized,
    'the matching Node assertion footer does not hide the terminal child denial');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '2 !== 0' })), null,
    'a footer exit code different from the child wrapper stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '1 !== 1' })), null,
    'a footer with a nonzero expected value stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '1 !== 0', footerSeparator: '\nnot blank\n' })), null,
    'a comparison without the blank-line boundary stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '1 !== 0\nextra text' })), null,
    'arbitrary text after the comparison stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '1 !== 0', parentCode: 'ERR_TEST_FAILURE' })), null,
    'the footer is accepted only in an assertion failure record');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { trailingError: true, assertionFooter: '1 !== 0' })), null,
    'a later Python exception stays ordinary even when the Node assertion footer follows');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { assertionFooter: '1 !== 0', footerSeparator: '\n' })), null,
    'a comparison without a blank-line boundary stays ordinary');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { traceback: false, assertionFooter: '1 !== 0' })), null,
    'an assertion footer does not turn non-traceback text into a Python denial');
  for (const errno of [1, 13]) {
    assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { wrapper: false, errno, assertionFooter: '1 !== 0' })), recognized,
      'a complete bare traceback and positive assertion exit prove a known child denial');
  }
  for (const [label, options] of [
    ['missing traceback', { traceback: false }],
    ['missing frame', { frame: false }],
    ['prefixed traceback marker', { prefixMarker: true }],
    ['later exception', { trailingError: true }],
    ['unknown errno', { errno: 2 }],
    ['zero exit', { assertionFooter: '0 !== 0' }],
    ['nonzero expected status', { assertionFooter: '1 !== 1' }],
    ['unsafe exit integer', { assertionFooter: '9007199254740992 !== 0' }],
    ['missing footer separation', { footerSeparator: '\n' }],
    ['text after footer', { assertionFooter: '1 !== 0\nextra text' }],
    ['non-assertion parent', { parentCode: 'ERR_TEST_FAILURE' }],
  ]) {
    assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { wrapper: false, assertionFooter: '1 !== 0', ...options })), null,
      `bare Python ${label} stays unclassified`);
  }
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(join(box.root, 'inside.txt'), { wrapper: false, assertionFooter: '1 !== 0' })), null,
    'bare Python in-repo access stays an ordinary failure');
  assert.equal(sandboxBlockedOperation(box.root, pythonChildTap(outside, { wrapper: false, assertionFooter: '1 !== 0' }), { includeFilePaths: false }), null,
    'bare Python does not bypass the file-path classification switch');
  const result = box.run('submit', '1');
  const output = `${result.out}\n${result.err}`;
  assert.equal(result.code, 1, output);
  assert.match(output, /GATE_RED/u);
  assert.doesNotMatch(output, /SANDBOX_BLOCKED/u);
});

/** Seed a small import graph with three independently discoverable test files. */
function seedGraph(box) {
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'src/middle.js', "export { value } from './a.js';\n");
  put(box.root, 'src/entry.js', "export const load = () => import('./middle.js');\n");
  put(box.root, 'src/other.js', 'export const other = true;\n');
  put(box.root, 'test/a.test.js', "import '../src/entry.js';\n");
  put(box.root, 'test/b.test.js', "import '../src/other.js';\n");
  put(box.root, 'test/c.test.js', "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  return commitAll(box);
}

test('one source change selects its direct and transitive static, re-export and literal dynamic importers [V4,C7]', (t) => {
  const box = privateRepo(t);
  const base = seedGraph(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): update source [G1]');

  const selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js']);
  assert.equal(selection.reason, '');
});

test('changed tests are selected and deleting or renaming a source retains importers of its old path [V4,C7]', (t) => {
  const box = privateRepo(t);
  const base = seedGraph(box);

  put(box.root, 'test/c.test.js', "import assert from 'node:assert/strict';\nassert.ok(true, 'changed test');\n");
  let commit = commitAll(box, 'test(core): update a test [G1]');
  let selection = selectAffectedTests(box.root, { base, commit });
  assert.deepEqual(selection.files, ['test/c.test.js'], 'a changed test includes itself');

  const renameBase = commit;
  box.git('mv', 'src/a.js', 'src/renamed.js');
  commit = commitAll(box, 'refactor(core): rename a source [G1]');
  selection = selectAffectedTests(box.root, { base: renameBase, commit });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js'], 'the old source path still reaches its importer');
});

test('unknown imports and broad inputs fall back explicitly, while an all-test closure is full [V4,C7]', (t) => {
  const box = privateRepo(t);
  const base = seedGraph(box);
  put(box.root, 'src/a.js', "export const load = name => import('./' + name + '.js');\n");
  const commit = commitAll(box, 'feat(core): add dynamic loading [G1]');
  const dynamic = selectAffectedTests(box.root, { base, commit });
  assert.equal(dynamic.full, true, 'a non-literal dynamic import fails closed');
  assert.match(dynamic.reason, /dynamic|compute|select/i);

  for (const path of ['bin/run-tests.js', 'package.json', 'package-lock.json', 'src/gate.js', 'src/affected-tests.js']) {
    const broad = selectAffectedTests(box.root, { base, commit, changed: [path] });
    assert.equal(broad.full, true, `${path} requires the full gate`);
    assert.ok(broad.reason, `${path} explains the fallback`);
  }

  put(box.root, 'src/a.js', 'export const value = 3;\n');
  put(box.root, 'test/b.test.js', "import '../src/a.js';\n");
  put(box.root, 'test/c.test.js', "import '../src/a.js';\n");
  const allTestsCommit = commitAll(box, 'test(core): cover shared source [G1]');
  const allTests = selectAffectedTests(box.root, { base, commit: allTestsCommit, changed: ['src/a.js'] });
  assert.equal(allTests.full, true, 'when every test is reached, the selection is the full gate');
  assert.deepEqual(allTests.files, ['test/a.test.js', 'test/b.test.js', 'test/c.test.js']);
});

test('an item claimed before the gate existed submits once a gate exists [C7,B26]', (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: '', shared: ['pullboard.json'] }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/a.js';",
    "appendFileSync(process.env.GATE_MARKER, 'accepted-main\\n');",
    'assert.equal(value, 2);',
  ].join('\n'));
  box = builderRepo(box);
  assert.equal(box.coordinator('add', 'build', 'Claim before setup', '--specs', 'G1').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): build the claimed item [G1]');
  const missing = box.run('submit', '1', '--json');
  assert.equal(missing.code, 1, missing.err || missing.out);
  assert.equal(JSON.parse(missing.out).error.code, 'NO_GATE', 'an unconfigured board still refuses');
  const before = JSON.parse(box.run('show', '1', '--json').out);
  const mainRoot = join(box.dir, 'repo');
  const accepted = JSON.parse(readFileSync(join(mainRoot, 'pullboard.json'), 'utf8'));
  accepted.gate = 'node --test --test-reporter=tap';
  put(mainRoot, 'pullboard.json', JSON.stringify(accepted));
  runFixtureGit(['add', 'pullboard.json'], { cwd: mainRoot, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: configure the project gate'], { cwd: mainRoot, env: box.env });
  box.git('merge', '--no-edit', 'main');
  const candidate = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  candidate.gate = `node -e "require('node:fs').appendFileSync(process.env.GATE_MARKER, 'candidate')"`;
  put(box.root, 'pullboard.json', JSON.stringify(candidate));
  commitAll(box, 'chore: expose an untrusted candidate gate');
  const marker = join(box.dir, 'gate-ran.log');
  box.env.GATE_MARKER = marker;
  const submitted = box.run('submit', '1', '--json', '--infra', 'the gate was configured after the claim');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  const receipt = JSON.parse(submitted.out);
  assert.equal(receipt.gate.green, true);
  assert.equal(receipt.gate.full, true, 'the newly configured gate really runs');
  assert.equal(readFileSync(marker, 'utf8'), 'accepted-main\n', 'only committed accepted-Main policy supplies the missing gate');
  const after = JSON.parse(box.run('show', '1', '--json').out);
  assert.equal(after.item_frozen_digest, before.item_frozen_digest, 'recovery needs no criterion change or refreeze');
});

test('submit runs the frozen check and affected test only; landing and explicit gate remain full [V4,C7,V16]', (t) => {
  let box = privateRepo(t);
  const checkCommand = 'node -e "require(\'node:fs\').appendFileSync(process.env.ITEM_CHECK_MARKER, \'check\')"';
  const checkMarker = join(box.dir, 'item-check.log');
  box.env.ITEM_CHECK_MARKER = checkMarker;
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', spec: 'SPEC.md', verify: 'any', lease: '2h' }, null, 2));
  put(box.root, 'SPEC.md', SPEC);
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/a.js';",
    "appendFileSync(process.env.AFFECTED_MARKER, 'affected\\n');",
    "assert.equal(value, 2);",
  ].join('\n'));
  put(box.root, 'test/b.test.js', [
    "import assert from 'node:assert/strict';",
    "assert.fail('independent test must not block this submit');",
  ].join('\n'));
  commitAll(box);
  box = builderRepo(box);
  const added = box.coordinator('add', 'build', 'Source change', '--check', checkCommand);
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);

  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'affected-ran.log');
  box.env.AFFECTED_MARKER = marker;
  rmSync(checkMarker, { force: true });
  const stamp = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
  writeFileSync(stamp, 'forged-stamp-must-not-change\n');

  const submitted = box.run('submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const receipt = JSON.parse(submitted.out);
  assert.equal(receipt.id, 1);
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.gate.green, true);
  assert.equal(receipt.gate.full, false);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
  assert.equal(receipt.gate.reason, '');
  assert.equal(receipt.gate.check.command, checkCommand);
  assert.equal(receipt.gate.check.green, true);
  assert.ok(existsSync(checkMarker), 'submit executes the item check rather than merely reporting it');
  assert.equal(readFileSync(checkMarker, 'utf8'), 'check', 'the frozen item check actually ran at submit');
  assert.ok(existsSync(marker), 'submit executes the selected test rather than merely reporting it');
  assert.equal(readFileSync(marker, 'utf8'), 'affected\n', 'submit really ran the selected test despite the full-gate stamp');
  assert.equal(readFileSync(stamp, 'utf8'), 'forged-stamp-must-not-change\n', 'subset proof never writes the full-gate stamp');

  rmSync(stamp);
  const explicit = box.run('gate');
  assert.notEqual(explicit.code, 0, 'the explicit configured full gate still sees the unrelated red test');
  assert.match(`${explicit.out}\n${explicit.err}`, /gate red/);
  const remote = join(box.dir, 'remote.git');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  const landing = runFixtureChild('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.notEqual(landing.status, 0, 'the landing pre-push hook still runs the full gate');
  assert.match(`${landing.stdout ?? ''}\n${landing.stderr ?? ''}`, /gate is red|not ok 2/);
  assert.equal(existsSync(stamp), false, 'neither subset nor red full gate leaves a green full-gate stamp');
});

test('a landing-gated project defers the full suite from submit to landing [V4,C7]', (t) => {
  /** Build a small project whose global-source edit selects the full gate.
   * @param {string} [initialSubmitGate]
   * @returns {{box: any, fullMarker: string, checkMarker: string}}
   */
  function project(initialSubmitGate) {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({
      gate: 'node --test', affectedTests: 'node --test', shared: ['pullboard.json'],
      ...(initialSubmitGate ? { submitGate: initialSubmitGate } : {}),
    }));
    seedGraph(box);
    const fullMarker = join(box.dir, 'full-suite.log');
    const checkMarker = join(box.dir, 'item-check.log');
    box.env.FULL_SUITE_MARKER = fullMarker;
    box.env.ITEM_CHECK_MARKER = checkMarker;
    for (const [file, name] of [['a', 'first'], ['b', 'second'], ['c', 'third']]) {
      put(box.root, `test/${file}.test.js`, [
        "import { appendFileSync } from 'node:fs';",
        ...(file === 'a' ? ["import '../src/entry.js';"] : []),
        `appendFileSync(process.env.FULL_SUITE_MARKER, '${name}\\n');`,
      ].join('\n') + '\n');
    }
    put(box.root, 'src/cli.js', 'export const version = 1;\n');
    commitAll(box, 'chore(core): prepare landing-gate fixture');
    box = builderRepo(box);
    const check = `node -e "require('node:fs').appendFileSync(process.env.ITEM_CHECK_MARKER, 'check\\n')"`;
    assert.equal(box.coordinator('add', 'build', 'Landing gate fixture', '--check', check).code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    rmSync(fullMarker, { force: true });
    rmSync(checkMarker, { force: true });
    return { box, fullMarker, checkMarker };
  }

  const optedIn = project();
  const mainRoot = join(optedIn.box.dir, 'repo');
  const mainConfig = JSON.parse(readFileSync(join(mainRoot, 'pullboard.json'), 'utf8'));
  mainConfig.submitGate = 'landing';
  put(mainRoot, 'pullboard.json', JSON.stringify(mainConfig));
  runFixtureGit(['add', 'pullboard.json'], { cwd: mainRoot, env: optedIn.box.env });
  runFixtureGit(['commit', '-q', '-m', 'feat(config): defer full suite to landing [G1]'], { cwd: mainRoot, env: optedIn.box.env });
  optedIn.box.git('merge', '--no-edit', 'main');
  put(optedIn.box.root, 'src/cli.js', 'export const version = 2;\n');
  commitAll(optedIn.box, 'feat(core): change global source [G1]');

  const deferred = optedIn.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(deferred.code, 0, deferred.err);
  const receipt = JSON.parse(deferred.out);
  assert.equal(receipt.gate.full, true, 'the selector still reports that it fell back to the whole suite');
  assert.equal(receipt.gate.deferred, true);
  assert.match(receipt.gate.report, /full suite deferred to the landing gate/u);
  assert.ok(existsSync(optedIn.checkMarker), 'the item check still runs');
  assert.equal(existsSync(optedIn.fullMarker), false, 'the submit did not run the deferred suite');
  const shown = optedIn.box.run('show', '1', '--json');
  assert.equal(shown.code, 0, shown.err);
  const submitEvent = JSON.parse(shown.out).thread.findLast((event) => event.kind === 'submit');
  assert.equal(submitEvent.detail.note, 'full suite deferred to the landing gate', 'the reviewer can see the durable submission note');
  const stamp = resolve(optedIn.box.root, optedIn.box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
  assert.equal(existsSync(stamp), false, 'deferral never creates a full-gate stamp');

  const landing = optedIn.box.run('gate', '--landing');
  assert.equal(landing.code, 0, landing.err);
  assert.deepEqual(readFileSync(optedIn.fullMarker, 'utf8').trim().split('\n').sort(), ['first', 'second', 'third'],
    'the landing gate runs the full configured suite');
  assert.ok(existsSync(stamp), 'only the actual full-suite pass stamps the tree');

  const candidateOnly = project();
  const candidateConfig = JSON.parse(readFileSync(join(candidateOnly.box.root, 'pullboard.json'), 'utf8'));
  candidateConfig.submitGate = 'landing';
  put(candidateOnly.box.root, 'pullboard.json', JSON.stringify(candidateConfig));
  put(candidateOnly.box.root, 'src/cli.js', 'export const version = 2;\n');
  commitAll(candidateOnly.box, 'feat(core): try candidate-only deferral [G1]');
  const ordinary = candidateOnly.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(ordinary.code, 0, ordinary.err);
  const ordinaryReceipt = JSON.parse(ordinary.out);
  assert.equal(ordinaryReceipt.gate.deferred, false, 'a candidate-only setting is not trusted');
  assert.ok(existsSync(candidateOnly.fullMarker), 'without current-main opt-in the full suite still runs at submit');
  const ordinaryEvent = JSON.parse(candidateOnly.box.run('show', '1', '--json').out).thread.findLast((event) => event.kind === 'submit');
  assert.equal(ordinaryEvent.detail.note, undefined, 'ordinary submissions do not claim the suite was deferred');

  const named = project('landing');
  put(named.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(named.box, 'feat(core): change one selected source [G1]');
  const selected = named.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(selected.code, 0, selected.err);
  const selectedReceipt = JSON.parse(selected.out);
  assert.equal(selectedReceipt.gate.full, false);
  assert.equal(selectedReceipt.gate.deferred, true);
  assert.deepEqual(selectedReceipt.gate.files, ['test/a.test.js']);
  assert.match(selectedReceipt.gate.report, /affected tests: test\/a\.test\.js; full suite deferred to the landing gate/u);
  assert.ok(existsSync(named.checkMarker), 'the item check runs for a named selection');
  assert.equal(readFileSync(named.fullMarker, 'utf8'), 'first\n', 'the named affected test runs without unrelated tests');
  const namedEvent = JSON.parse(named.box.run('show', '1', '--json').out).thread.findLast((event) => event.kind === 'submit');
  assert.equal(namedEvent.detail.note, 'full suite deferred to the landing gate', 'the reviewer sees deferral for named affected tests too');
});

test("a landing-gated submit runs the project's invariant tests [V4,C7]", (t) => {
  /** Prepare accepted policy, then claim in a real separate builder checkout. */
  function project(invariants, failing = false) {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test',
      submitGate: 'landing', shared: ['pullboard.json'], ...(invariants === undefined ? {} : { submitInvariants: invariants }) }));
    seedGraph(box);
    const marker = join(box.dir, 'invariants.log');
    box.env.INVARIANT_MARKER = marker;
    put(box.root, 'test/invariant.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/a.js';",
      "appendFileSync(process.env.INVARIANT_MARKER, 'invariant\\n');",
      failing ? 'assert.equal(value, 1, "the project invariant stays enforced");' : 'assert.ok(value < 3);',
    ].join('\n') + '\n');
    put(box.root, 'test/a.test.js', "import '../src/entry.js';\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.INVARIANT_MARKER, 'selected\\n');\n");
    put(box.root, 'test/c.test.js', "throw new Error('unrelated test must stay deferred');\n");
    put(box.root, 'src/cli.js', 'export const version = 1;\n');
    commitAll(box);
    box = builderRepo(box);
    assert.equal(box.coordinator('add', 'build', 'Invariant fixture', '--check', 'node -e "process.exit(0)"').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    return { box, marker };
  }
  /** A global edit exercises the uncertain-selector path without running a full suite. */
  function change(box, global = true) {
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    if (global) put(box.root, 'src/cli.js', 'export const version = 2;\n');
    commitAll(box, 'feat(core): change invariant input [G1]');
  }
  /** A submit subset must never leave a full-gate stamp. */
  function unstamped(box) {
    const stamp = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
    assert.equal(existsSync(stamp), false);
  }

  const empty = project();
  change(empty.box);
  const unchanged = empty.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(unchanged.code, 0, unchanged.err);
  assert.equal(existsSync(empty.marker), false, 'the empty default adds no tests');
  unstamped(empty.box);

  const mandatory = project(['test/invariant.test.js']);
  change(mandatory.box);
  const guarded = mandatory.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(guarded.code, 0, guarded.err);
  const guardedReceipt = JSON.parse(guarded.out);
  assert.equal(guardedReceipt.gate.full, true, 'the selector still reports an uncertain full fallback');
  assert.equal(guardedReceipt.gate.deferred, true);
  assert.deepEqual(guardedReceipt.gate.files, ['test/invariant.test.js'], 'receipt names only the executed invariant subset');
  assert.equal(readFileSync(mandatory.marker, 'utf8'), 'invariant\n', 'global fallback does not run unrelated selected/full tests');
  assert.match(guardedReceipt.gate.report, /submit invariants: test\/invariant\.test\.js; full suite deferred/u);
  unstamped(mandatory.box);

  const red = project(['test/invariant.test.js'], true);
  change(red.box);
  const refused = red.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.notEqual(refused.code, 0, 'a failing configured invariant must refuse the submit');
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.ok(existsSync(red.marker), 'the listed invariant actually ran');
  unstamped(red.box);

  const trusted = project([], true);
  const acceptedRoot = join(trusted.box.dir, 'repo');
  const policy = JSON.parse(readFileSync(join(acceptedRoot, 'pullboard.json'), 'utf8'));
  policy.submitInvariants = ['test/invariant.test.js'];
  put(acceptedRoot, 'pullboard.json', JSON.stringify(policy));
  runFixtureGit(['add', 'pullboard.json'], { cwd: acceptedRoot, env: trusted.box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: require project invariant'], { cwd: acceptedRoot, env: trusted.box.env });
  trusted.box.git('merge', '--no-edit', 'main');
  const candidate = JSON.parse(readFileSync(join(trusted.box.root, 'pullboard.json'), 'utf8'));
  candidate.submitInvariants = ['test/c.test.js'];
  put(trusted.box.root, 'pullboard.json', JSON.stringify(candidate));
  change(trusted.box);
  const ignored = trusted.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.notEqual(ignored.code, 0, 'accepted main policy overrides both the claim-time list and candidate edit');
  assert.match(ignored.err + ignored.out, /GATE_RED/u);
  assert.ok(existsSync(trusted.marker), 'the accepted-main invariant still ran');
  assert.doesNotMatch(ignored.err + ignored.out, /unrelated test must stay deferred/u);
  unstamped(trusted.box);

  const missing = project(['test/invariant.test.js']);
  rmSync(join(missing.box.root, 'test/invariant.test.js'));
  change(missing.box);
  const absent = missing.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.notEqual(absent.code, 0, 'deleting a mandatory file cannot make the guard disappear');
  assert.match(absent.err + absent.out, /submitInvariants file test\/invariant\.test\.js is missing or unreadable/u);
  unstamped(missing.box);

  const named = project(['test/invariant.test.js', 'test/invariant.test.js']);
  change(named.box, false);
  const selected = named.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(selected.code, 0, selected.err);
  const receipt = JSON.parse(selected.out);
  assert.equal(receipt.gate.full, false);
  assert.equal(receipt.gate.deferred, true);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js', 'test/invariant.test.js']);
  assert.deepEqual(readFileSync(named.marker, 'utf8').trim().split('\n').sort(), ['invariant', 'selected'], 'selected and mandatory overlap runs once');
  assert.match(receipt.gate.report, /full suite deferred to the landing gate/u);
  unstamped(named.box);
});

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

test('submit without a frozen check reports no item check and still runs affected tests [V4,C7,V16]', (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', "import '../src/a.js'; import { appendFileSync } from 'node:fs'; appendFileSync(process.env.AFFECTED_MARKER, 'ran');\n");
  put(box.root, 'test/b.test.js', "import assert from 'node:assert/strict'; assert.fail('unrelated');\n");
  commitAll(box);
  box = builderRepo(box);
  assert.equal(box.coordinator('add', 'build', 'No frozen command').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'without-check.log');
  box.env.AFFECTED_MARKER = marker;
  const result = box.run('submit', '1', '--json');
  assert.equal(result.code, 0, result.err);
  const receipt = JSON.parse(result.out);
  assert.match(receipt.gate.report, /no item check/u);
  assert.equal(receipt.gate.check.checked, false);
  assert.equal(receipt.gate.full, false);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
  assert.ok(existsSync(marker), 'the affected test ran without an item check');
  assert.equal(readFileSync(marker, 'utf8'), 'ran');
});

test('a red frozen item check refuses submit before affected tests run [V4,C7,V16]', (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  box = builderRepo(box);
  const added = box.coordinator('add', 'build', 'Frozen check', '--check', 'node -e "process.exit(process.env.CHECK_REFUSE ? 1 : 0)"');
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): update selected source [G1]');
  box.env.CHECK_REFUSE = '1';
  const refused = box.run('submit', '1');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.match(refused.err, /item check red/u);
});


test('CommonJS and nested package scopes fall back instead of silently missing require edges [V4,V16]', (t) => {
  const common = privateRepo(t);
  put(common.root, 'package.json', '{"type":"commonjs"}\n');
  put(common.root, 'src/a.js', 'module.exports = 1;\n');
  put(common.root, 'test/a.test.js', "require('../src/a.js');\n");
  put(common.root, 'test/b.test.js', "require('node:assert/strict').ok(true);\n");
  const base = commitAll(common);
  put(common.root, 'src/a.js', 'module.exports = 2;\n');
  const commit = commitAll(common, 'feat(core): change CommonJS source [G1]');
  const selection = selectAffectedTests(common.root, { base, commit });
  assert.equal(selection.full, true, 'require import edges cannot be silently omitted');
  assert.match(selection.reason, /CommonJS|package scope/u);

  const nested = privateRepo(t);
  seedGraph(nested);
  put(nested.root, 'legacy/package.json', '{"type":"commonjs"}\n');
  put(nested.root, 'legacy/value.js', 'module.exports = 1;\n');
  const nestedBase = commitAll(nested);
  put(nested.root, 'legacy/value.js', 'module.exports = 2;\n');
  const nestedCommit = commitAll(nested, 'feat(core): change nested CommonJS source [G1]');
  const scoped = selectAffectedTests(nested.root, { base: nestedBase, commit: nestedCommit });
  assert.equal(scoped.full, true, 'nested package policy makes a single ESM graph incomplete');
  assert.match(scoped.reason, /package scope/u);

  const esm = privateRepo(t);
  const esmBase = seedGraph(esm);
  put(esm.root, 'src/a.js', "import { createRequire } from 'node:module'; export const load = createRequire(import.meta.url);\n");
  const esmCommit = commitAll(esm, 'feat(core): create a CommonJS loader [G1]');
  const loader = selectAffectedTests(esm.root, { base: esmBase, commit: esmCommit });
  assert.equal(loader.full, true, 'a reached CommonJS loader also makes the ESM import graph incomplete');
  assert.match(loader.reason, /CommonJS/u);
});


for (const mode of ['topic parent', 'merge commit']) {
  test(`affected tests include source changes carried by a ${mode} [V4,C7,V16]`, (t) => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box);
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      "appendFileSync(process.env.AFFECTED_MARKER, 'ran\\n');",
      'assert.equal(value, 1);',
    ].join('\n'));
    box = builderRepo(box);
    assert.equal(box.coordinator('add', 'build', 'Merged source', '--check', 'true').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    const branch = box.git('branch', '--show-current');
    box.git('checkout', '-q', '-b', 'topic');
    put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): topic source [G1]');
    box.git('checkout', '-q', branch);
    if (mode === 'merge commit') {
      put(box.root, 'src/other.js', 'export const other = false;\n');
      commitAll(box, 'feat(core): unrelated source [G1]');
      box.git('merge', '--no-ff', '--no-commit', 'topic');
      put(box.root, 'src/a.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): resolve merged source [G1]');
    } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic source [G1]');
    assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'the candidate really has two parents');
    const marker = join(box.dir, 'merged-test-ran.log');
    box.env.AFFECTED_MARKER = marker;
    const standalone = runFixtureChild(process.execPath, ['--test', 'test/a.test.js'], { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the merged source regression');
    assert.match(standalone.stdout, /ERR_ASSERTION/u);
    rmSync(marker);
    const refused = box.run('submit', '1');
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.match(refused.err + refused.out, /GATE_RED/u);
    assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
    assert.match(refused.err, /ERR_ASSERTION/u);
    assert.equal(readFileSync(marker, 'utf8'), 'ran\nran\n', 'submit executes the transitive importer against the candidate and exact main');
  });
}

test('a computed-import test joins the selection only when it declares what it loads, and undeclared forces full [V4,C7]', (t) => {
  const box = privateRepo(t);
  const original = seedGraph(box);
  put(box.root, 'test/c.test.js', "export const load = path => import(path);\n");
  const base = commitAll(box);
  const added = selectAffectedTests(box.root, { base: original, commit: base, changed: ['src/a.js'] });
  assert.equal(added.full, true, 'an undeclared computed import cannot be read, so the whole suite runs');
  assert.match(added.reason, /test\/c\.test\.js/u, 'the reason names the undeclared file');
  put(box.root, 'test/c.test.js', "/** @pullboard-test-loads src/a.js */\nexport const load = path => import(path);\n");
  const declared = commitAll(box, 'test(core): declare what the loader reads [G1]');
  put(box.root, 'src/a.js', 'export const value = 2;\n'); let commit = commitAll(box, 'feat(core): source change [G1]');
  let selection = selectAffectedTests(box.root, { base: declared, commit }); assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js', 'test/c.test.js'], 'a declared loader of the changed module is selected');
  selection = selectAffectedTests(box.root, { base: declared, commit, changed: ['test/c.test.js'] });
  assert.equal(selection.full, false, 'reaching a computed-import test does not force full'); assert.deepEqual(selection.files, ['test/c.test.js']);
  put(box.root, 'test/c.test.js', "import 'node:assert/strict';\n");
  commit = commitAll(box, 'test(core): remove computed loader [G1]');
  selection = selectAffectedTests(box.root, { base: declared, commit, changed: ['src/a.js'] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js', 'test/c.test.js'], 'the old graph keeps its declared loader selected');
});


/** Test-tree readers are data dependencies even when no import reaches their scanner. */
test('a changed test file selects the scanners that read test files [C7,B3]', (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const declaration = '/** @pullboard-test-input test-tree */\n';
  put(box.root, 'test/chrome-fixture.test.js', "import 'node:assert/strict';\n");
  put(box.root, 'test/wall-clock-budgets.test.js', declaration + "import 'node:assert/strict';\n");
  put(box.root, 'test/nested/reader.test.mjs', declaration + "import 'node:fs';\n");
  put(box.root, 'test/comment-only.test.js', "const text = '/** @pullboard-test-input test-tree */';\n");
  const base = commitAll(box);
  put(box.root, 'test/chrome-fixture.test.js', "import 'node:assert/strict';\n// changed test behavior\n");
  const commit = commitAll(box, 'test(core): change browser regression [G1]');
  const expected = ['test/chrome-fixture.test.js', 'test/nested/reader.test.mjs', 'test/wall-clock-budgets.test.js'];
  const selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false, 'declared scanners add their own files without selecting unrelated tests');
  assert.deepEqual(selection.files, expected, 'a change only to the browser test selects the real scanner names');
  assert.ok(readFileSync(join(import.meta.dirname, 'wall-clock-budgets.test.js'), 'utf8').startsWith(declaration),
    'the repository clock scanner declares its test-tree input');
  for (const path of ['test/support.js', 'test/new.test.js', 'test.js']) {
    assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: [path] }).files,
      expected.filter(file => file !== 'test/chrome-fixture.test.js'), path + ' changes the scanner input tree');
  }
  assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: ['src/a.js'] }).files, ['test/a.test.js'],
    'a source-only change keeps the normal import closure');
  put(box.root, 'test/wall-clock-budgets.test.js', "import 'node:assert/strict';\n");
  const removed = commitAll(box, 'test(core): remove scanner declaration [G1]');
  assert.deepEqual(selectAffectedTests(box.root, { base: commit, commit: removed, changed: ['test/chrome-fixture.test.js'] }).files,
    expected, 'the old graph retains a scanner whose declaration was removed');

  // Use committed repository sources so a real scanner cannot be replaced by a synthetic stand-in.
  const repository = resolve(import.meta.dirname, '..');
  const actual = privateRepo(t);
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'test/'], {
    cwd: repository, encoding: 'utf8',
  }).split('\0').filter(path => /\.[cm]?js$/u.test(path));
  const actualBase = copyRepositoryFixture(actual, repository, tracked);
  appendFileSync(join(actual.root, 'test/cockpit/demo.test.js'), '\n// Only the cockpit input changes.\n');
  const actualCommit = commitAll(actual, 'test(core): change cockpit input [G1]');
  assert.deepEqual(actual.git('diff', '--name-only', actualBase, actualCommit).split('\n'),
    ['test/cockpit/demo.test.js'], 'the real-source fixture changes only the cockpit test');
  const actualSelection = selectAffectedTests(actual.root, { base: actualBase, commit: actualCommit });
  assert.equal(actualSelection.full, false, 'a cockpit-only input keeps affected selection');
  for (const scanner of ['test/wall-clock-budgets.test.js', 'test/submit-gate.test.js']) {
    assert.ok(actualSelection.files.includes(scanner), 'actual test-tree reader selected: ' + scanner);
  }
});

/** Source-tree declarations cover text scanners without broadening unrelated import closures. */
test('a source change selects the tests that scan sources [C7,B3]', (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const sourceInput = '/** @pullboard-test-input source-tree */\n';
  const testInput = '/** @pullboard-test-input test-tree */\n';
  put(box.root, 'test/scanner.test.js', sourceInput + "import 'node:fs';\n");
  put(box.root, 'test/both.test.js', testInput + sourceInput + "import 'node:fs';\n");
  put(box.root, 'test/nested/both.test.mjs', (sourceInput + testInput).replaceAll('\n', '\r\n') + "import 'node:fs';\n");
  put(box.root, 'test/tests-only.test.js', testInput + "import 'node:fs';\n");
  put(box.root, 'test/quoted.test.js', "const text = '/** @pullboard-test-input source-tree */';\n");
  put(box.root, 'test/late.test.js', "// Not an input declaration.\n" + sourceInput);
  const base = commitAll(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): change source scanner input [G1]');
  const readers = ['test/both.test.js', 'test/nested/both.test.mjs', 'test/scanner.test.js'];
  const selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false, 'scanner declarations keep affected selection');
  assert.deepEqual(selection.files, ['test/a.test.js', ...readers].sort(),
    'the source change adds declared scanners to its normal import closure');
  for (const path of ['src/new.js', 'bin/tool.mjs']) {
    assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: [path] }).files, readers,
      path + ' selects scanners without an import edge');
  }
  assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: ['test/c.test.js'] }).files,
    ['test/both.test.js', 'test/c.test.js', 'test/nested/both.test.mjs', 'test/tests-only.test.js'],
    'both declaration orders retain test-tree selection without adding source-only readers');
  assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: ['lib/unrelated.js'] }).files, [],
    'other trees keep their existing import selection');
  put(box.root, 'test/scanner.test.js', "import 'node:fs';\n");
  const removed = commitAll(box, 'test(core): remove source declaration [G1]');
  assert.deepEqual(selectAffectedTests(box.root, { base: commit, commit: removed, changed: ['src/new.js'] }).files,
    readers, 'old declarations retain readers across removal');
  put(box.root, 'test/scanner.test.js', sourceInput + "import 'node:fs';\n");
  const deletionBase = commitAll(box, 'test(core): restore scanner declaration [G1]');
  box.git('rm', 'src/a.js');
  const deleted = commitAll(box, 'refactor(core): remove source input [G1]');
  assert.deepEqual(selectAffectedTests(box.root, { base: deletionBase, commit: deleted }).files,
    ['test/a.test.js', ...readers].sort(), 'source deletion retains old importers and scanners');

  const repository = resolve(import.meta.dirname, '..');
  const actual = privateRepo(t);
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'bin/', 'test/'], {
    cwd: repository, encoding: 'utf8',
  }).split('\0').filter(path => /\.[cm]?js$/u.test(path));
  const actualBase = copyRepositoryFixture(actual, repository, tracked);
  put(actual.root, 'src/scanner-input.js', 'export const scannerInput = true;\n');
  const actualCommit = commitAll(actual, 'test(core): add an unimported source input [G1]');
  const actualSelection = selectAffectedTests(actual.root, { base: actualBase, commit: actualCommit });
  assert.equal(actualSelection.full, false, 'an unimported source addition keeps affected selection');
  for (const scanner of ['test/boundary.test.js', 'test/machine.test.js', 'test/package.test.js',
    'test/submit-gate.test.js', 'test/wall-clock-budgets.test.js']) {
    assert.ok(readFileSync(join(repository, scanner), 'utf8').split(/\r?\n/u).slice(0, 2).includes(sourceInput.trimEnd()),
      'actual source-tree reader declares its input: ' + scanner);
    assert.ok(actualSelection.files.includes(scanner), 'actual source-tree reader selected: ' + scanner);
  }
});

test('affected selection says explicitly when no claim head was recorded [V4,C7]', (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const selection = selectAffectedTests(box.root, { base: null, trunk: 'refs/heads/main' });
  assert.equal(selection.full, true);
  assert.match(selection.reason, /no claim head recorded/u);
});


test('affected selection reads old edges and all changes at the trunk merge base [V4,C7]', (t) => {
  const box = privateRepo(t);
  const trunk = seedGraph(box);
  box.git('rm', 'src/a.js');
  const claim = commitAll(box, 'refactor(core): remove old source [G1]');
  // A claim made after the deletion and an empty receipt must not hide the trunk-relative change.
  const selection = selectAffectedTests(box.root, { base: claim, trunk, changed: [] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js']);
});


test('affected submit includes branch changes made before the item claim [V4,C7,V16]', (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  put(box.root, 'test/a.test.js', "import assert from 'node:assert/strict'; import { value } from '../src/middle.js'; assert.equal(value, 1);\n");
  box = builderRepo(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): source before claim [G1]');
  assert.equal(box.coordinator('add', 'build', 'Existing source change', '--check', 'true').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  put(box.root, 'src/other.js', 'export const other = false;\n');
  commitAll(box, 'feat(core): source after claim [G1]');
  const refused = box.run('submit', '1');
  assert.equal(refused.code, 1, refused.out || refused.err);
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
  assert.match(refused.err, /ERR_ASSERTION/u);
});


for (const mode of ['deleted source', 'topic parent', 'merge commit']) {
  test(`affected submit on main includes a ${mode} since its claim [V4,C7,V16]`, (t) => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', lanes: { core: { owns: ['src/', 'test/'], specs: ['G'] } } }));
    seedGraph(box);
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      "appendFileSync(process.env.AFFECTED_MARKER, 'ran\\n');",
      'assert.equal(value, 1);',
    ].join('\n'));
    commitAll(box);
    const added = box.run('add', 'coordinator', 'Main checkout source', '--check', 'true');
    assert.equal(added.code, 0, added.err);
    const claimed = box.run('claim', '1');
    assert.equal(claimed.code, 0, claimed.err);
    if (mode === 'deleted source') {
      box.git('rm', 'src/a.js');
      commitAll(box, 'refactor(core): delete source on main [G1]');
    } else {
      box.git('checkout', '-q', '-b', 'topic');
      put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): topic source [G1]');
      box.git('checkout', '-q', 'main');
      if (mode === 'merge commit') {
        put(box.root, 'src/other.js', 'export const other = false;\n');
        commitAll(box, 'feat(core): unrelated main source [G1]');
        box.git('merge', '--no-ff', '--no-commit', 'topic');
        put(box.root, 'src/a.js', 'export const value = 2;\n');
        commitAll(box, 'feat(core): resolve main merge [G1]');
      } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic into main [G1]');
      assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    }
    assert.equal(box.git('branch', '--show-current'), 'main', 'submit runs in the actual main checkout');
    const marker = join(box.dir, 'main-importer-ran.log');
    box.env.AFFECTED_MARKER = marker;
    const standalone = runFixtureChild(process.execPath, ['--test', 'test/a.test.js'], { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the source regression');
    assert.match(standalone.stdout, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    rmSync(marker, { force: true });
    const refused = box.run('submit', '1');
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.match(refused.err + refused.out, /GATE_RED/u);
    assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
    assert.match(refused.err, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    if (mode !== 'deleted source') assert.equal(readFileSync(marker, 'utf8'), 'ran\nran\n', 'submit executes the unchanged transitive importer against the candidate and exact main');
  });
}

test('a sandbox-blocked gate asks the person [I1,C7]', async (t) => {
  const command = 'node -e "console.error(process.env.BLOCKED_DIAGNOSTIC); process.exit(Number(process.env.BLOCKED_EXIT || 1))"';
  /** Assert the actual CLI keeps the refused operation and routes the access request through the coordinator. */
  function blocked(result, operation) {
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.err, /SANDBOX_BLOCKED/u);
    assert.ok(result.err.includes(operation), result.err);
    assert.match(result.err, /ask the coordinator to bring (?:it|this operation) to the person/iu);
    assert.match(result.err, /pullboard shout coordinator .*--decision/u);
    assert.doesNotMatch(result.err, /\bask the person\b/iu);
    assert.match(result.err, /run the gate outside the sandbox/u);
    assert.match(result.err, /keep the tests unchanged/u);
  }
  await t.test('full gates distinguish listener denial from ordinary failures [I1,C7]', () => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: command }));
    seedGraph(box);
    box.env.BLOCKED_DIAGNOSTIC = 'Error: listen EPERM: operation not permitted 127.0.0.1:0';
    blocked(box.run('gate'), 'listen');
    const log = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate.log'));
    assert.match(readFileSync(log, 'utf8'), /Error: listen EPERM/u, 'the original diagnostic is retained');
    assert.ok(existsSync(log + '.profile.json'), 'ordinary timings are retained');
    box.env.BLOCKED_DIAGNOSTIC = 'Error: bind EACCES: permission denied 127.0.0.1:0';
    blocked(box.run('gate'), 'bind');
    for (const diagnostic of [
      'AssertionError [ERR_ASSERTION]: expected EPERM when listen was called',
      'Error: listen EADDRINUSE: address already in use',
      `Error: EACCES: permission denied, open '${join(box.root, 'inside.txt')}'`,
    ]) {
      box.env.BLOCKED_DIAGNOSTIC = diagnostic;
      const ordinary = box.run('gate');
      assert.equal(ordinary.code, 1, ordinary.out + ordinary.err);
      assert.doesNotMatch(ordinary.out + ordinary.err, /SANDBOX_BLOCKED/u);
      assert.match(ordinary.out, /gate red/u);
    }
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node -e "require(\'node:assert/strict\').fail(\'ordinary assertion\')"' }));
    commitAll(box);
    const assertion = box.run('gate');
    assert.equal(assertion.code, 1);
    assert.match(assertion.out, /AssertionError/u);
    assert.doesNotMatch(assertion.out + assertion.err, /SANDBOX_BLOCKED/u);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: command }));
    commitAll(box);
    box.env.BLOCKED_DIAGNOSTIC = 'Error: listen EPERM: operation not permitted';
    box.env.BLOCKED_EXIT = '0';
    const green = box.run('gate');
    assert.equal(green.code, 0, green.err);
    assert.doesNotMatch(green.out + green.err, /SANDBOX_BLOCKED/u, 'a successful diagnostic is not a refusal');
  });
  await t.test('real outside-file TAP denials refuse while permission assertions stay ordinary [I1,C7]', () => {
    let box = privateRepo(t);
    const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../bin/run-tests.js'))} test/permission.test.js`;
    const directory = join(box.dir, 'readonly-outside-worktree');
    mkdirSync(directory);
    const outside = join(directory, "outside'quote.txt");
    put(box.root, 'pullboard.json', JSON.stringify({ gate: runner }));
    seedGraph(box);
    const operation = `writeFileSync(${JSON.stringify(outside)}, 'blocked')`;
    const prefix = "import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\nimport assert from 'node:assert/strict';\n";
    const denied = prefix + `test('actual outside write', () => ${operation});\n`;
    put(box.root, 'test/permission.test.js', denied);
    commitAll(box);
    box = builderRepo(box);
    chmodSync(directory, 0o500); // The real add baseline must observe the same outside-file refusal.
    assert.equal(box.coordinator('add', 'build', 'Real permission check', '--check', runner).code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    const item = { ...JSON.parse(box.coordinator('show', '1', '--json').out), item_commit: box.git('rev-parse', 'HEAD').trim() };
    try {
      assert.throws(() => writeFileSync(outside, 'sentinel'), { code: 'EACCES' }, 'the operating system actually denies this write');
      blocked(box.run('gate'), outside);
      blocked(box.run('check', '1', '--yes'), outside);
      blocked(box.run('submit', '1'), outside);
      const privateResult = checkAtCommit(box.root, item);
      assert.equal(privateResult.state, 'red');
      assert.ok(privateResult.sandboxBlocked?.includes(outside), 'the real private checker scans the TAP record');
      assert.throws(() => refuseSandboxBlocked(privateResult), { code: 'SANDBOX_BLOCKED' });
      const raw = readFileSync(privateResult.outputPath, 'utf8');
      assert.match(raw, /code: 'EACCES'/u);
      assert.ok(raw.includes(outside));
      assert.ok(existsSync(privateResult.profilePath));
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion mentioning permission', () => { try { ${operation}; } catch (error) { assert.fail(error.message); } });\n`);
      commitAll(box);
      const ordinary = box.run('gate');
      assert.equal(ordinary.code, 1);
      assert.match(ordinary.out, /ERR_ASSERTION/u);
      assert.doesNotMatch(ordinary.out + ordinary.err, /SANDBOX_BLOCKED/u);
      const printedDiagnostic = `Error: EACCES: permission denied, open '${outside}'`;
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion prints a permission-looking diagnostic', () => { console.error(${JSON.stringify(printedDiagnostic)}); assert.equal(1, 2); });\n`);
      commitAll(box);
      const printedAssertion = box.run('gate');
      assert.equal(printedAssertion.code, 1);
      assert.doesNotMatch(printedAssertion.out + printedAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(printedAssertion.out, /ERR_ASSERTION/u);
      assert.match(printedAssertion.out, /# Error: EACCES: permission denied/u, 'TAP retains the test diagnostic as a comment');
      const multilineDiagnostic = `ordinary assertion detail\nError: EACCES: permission denied, open '${outside}'`;
      put(box.root, 'test/permission.test.js', prefix + `test('multiline assertion detail contains a permission-looking line', () => { assert.fail(${JSON.stringify(multilineDiagnostic)}); });\n`);
      commitAll(box);
      const multilineAssertion = box.run('gate');
      assert.equal(multilineAssertion.code, 1);
      assert.doesNotMatch(multilineAssertion.out + multilineAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(multilineAssertion.out, /ERR_ASSERTION/u);
      assert.match(multilineAssertion.out, /Error: EACCES: permission denied/u);
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion logs a caught OS error', () => { try { ${operation}; } catch (error) { console.error(error); } assert.equal(1, 2); });\n`);
      commitAll(box);
      const caughtAssertion = box.run('gate');
      assert.equal(caughtAssertion.code, 1);
      assert.doesNotMatch(caughtAssertion.out + caughtAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(caughtAssertion.out, /ERR_ASSERTION/u);
      put(box.root, 'test/permission.test.js', denied);
      commitAll(box);
    } finally { chmodSync(directory, 0o700); }
    const allowed = box.run('gate');
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
    assert.equal(readFileSync(outside, 'utf8'), 'blocked', 'the unchanged real write succeeds when access is restored');
  });
  await t.test('module-startup outside-file denials preserve fatal TAP evidence [I1,C7]', (t) => {
    const box = privateRepo(t);
    const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../bin/run-tests.js'))} test/permission.test.js`;
    put(box.root, 'pullboard.json', JSON.stringify({ gate: runner }));
    const directory = join(box.dir, 'readonly-module-startup');
    mkdirSync(directory);
    const outside = join(directory, 'outside.txt');
    const testSource = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(outside)}, 'blocked during module evaluation');\n`;
    put(box.root, 'test/permission.test.js', testSource);
    commitAll(box);
    chmodSync(directory, 0o500);
    try {
      assert.throws(() => writeFileSync(outside, 'sentinel'), { code: 'EACCES' }, 'the OS blocks the exact outside path');
      const result = box.run('gate');
      const rawPath = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate.log'));
      const innerGateLog = readFileSync(rawPath, 'utf8');
      t.diagnostic(JSON.stringify({ actualPermissionSentinel: 'EACCES', command: 'pullboard gate', code: result.code, stdout: result.out, stderr: result.err, innerGateLog }));
      assert.equal(result.code, 1, result.out + result.err);
      assert.match(result.err, /SANDBOX_BLOCKED/u, 'a real module-startup denial is named for the person');
      assert.ok(result.err.includes(outside), 'the refusal identifies the outside path');
      assert.match(innerGateLog, /# Error: EACCES: permission denied, open /u);
      assert.ok(innerGateLog.includes(`path: '${outside}'`), 'the fatal stack keeps Node’s exact denied path');
      assert.ok(innerGateLog.includes("code: 'ERR_TEST_FAILURE'"), 'Node frames the module-load denial as a test-file failure');
      assert.match(innerGateLog, /failureType: '?testCodeFailure'?(?:\r?\n|$)/u);
      assert.match(innerGateLog, /not ok \d+ - (?:.*\/)?test\/permission\.test\.js/u);
    } finally { chmodSync(directory, 0o700); }
    const allowed = box.run('gate');
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
    assert.equal(readFileSync(outside, 'utf8'), 'blocked during module evaluation');
  });
  await t.test('frozen checks retain outside-file refusal before submit proof [I1,C7]', () => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box);
    box = builderRepo(box);
    const added = box.coordinator('add', 'build', 'Sandbox check', '--check', command);
    assert.equal(added.code, 0, added.err);
    assert.equal(box.run('claim', '1').code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    const outside = join(box.dir, 'outside.txt');
    box.env.BLOCKED_DIAGNOSTIC = `Error: EACCES: permission denied, open '${outside}'`;
    blocked(box.run('check', '1', '--yes'), 'open');
    blocked(box.run('submit', '1'), 'open');
    const log = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-submit.log.check.log'));
    assert.ok(readFileSync(log, 'utf8').includes(outside), 'the exact refused path remains in the raw log');
    box.env.BLOCKED_DIAGNOSTIC = 'AssertionError [ERR_ASSERTION]: ordinary assertion';
    const ordinary = box.run('submit', '1');
    assert.equal(ordinary.code, 1);
    assert.match(ordinary.err, /GATE_RED/u);
    assert.doesNotMatch(ordinary.err, /SANDBOX_BLOCKED/u);
    box.env.BLOCKED_EXIT = '0';
    assert.equal(box.run('submit', '1').code, 0, 'the unchanged check can pass when the operation is allowed');
    const item = JSON.parse(box.coordinator('show', '1', '--json').out);
    /** Run the actual private checker with only these fixture diagnostics in its child environment. */
    function privateCheck(diagnostic) {
      const savedDiagnostic = process.env.BLOCKED_DIAGNOSTIC;
      const savedExit = process.env.BLOCKED_EXIT;
      process.env.BLOCKED_DIAGNOSTIC = diagnostic;
      process.env.BLOCKED_EXIT = '1';
      try { return checkAtCommit(box.root, item); }
      finally {
        if (savedDiagnostic === undefined) delete process.env.BLOCKED_DIAGNOSTIC;
        else process.env.BLOCKED_DIAGNOSTIC = savedDiagnostic;
        if (savedExit === undefined) delete process.env.BLOCKED_EXIT;
        else process.env.BLOCKED_EXIT = savedExit;
      }
    }
    const privateResult = privateCheck('Error: listen EPERM: operation not permitted\n' + 'ordinary trailing output\n'.repeat(80));
    assert.equal(privateResult.state, 'red');
    assert.equal(privateResult.sandboxBlocked, 'listen (EPERM)', 'classification scans before the bounded tail');
    assert.doesNotMatch(privateResult.outputTail, /EPERM/u);
    assert.throws(() => refuseSandboxBlocked(privateResult), { code: 'SANDBOX_BLOCKED' });
    assert.match(readFileSync(privateResult.outputPath, 'utf8'), /Error: listen EPERM/u);
    assert.ok(existsSync(privateResult.profilePath));
    const inside = privateCheck("Error: EACCES: permission denied, open './inside.txt'");
    assert.equal(inside.state, 'red');
    assert.equal(inside.sandboxBlocked, null, 'a private-clone file stays inside that check worktree');
    assert.equal(JSON.parse(box.coordinator('show', '1', '--json').out).item_status, 'submitted', 'checks alone record no verdict');
  });
});

test('nested TAP child denials require bounded matching fatal details [C7,B26]', (t) => {
  const box = privateRepo(t);
  const outside = join(box.dir, 'outside-denied.txt');
  /** Build a failed child TAP record with configurable structured error fields. */
  function tapChildError({ code = 'EACCES', messageCode = 'EACCES', syscall = 'open', path = outside, extra = '' } = {}) {
    return [
      'TAP version 13',
      'not ok 1 - child opens a denied file',
      '  ---',
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      '    App exited before opening the file (code 1, signal null):',
      `    Error: ${messageCode}: permission denied, ${syscall} '${outside}'`,
      '    {',
      `      code: '${code}',`,
      `      syscall: '${syscall}',`,
      `      path: '${path}'`,
      '    }',
      ...extra.split('\n').filter(Boolean).map((line) => `    ${line}`),
      "  code: 'ERR_ASSERTION'",
      '  ...',
    ].join('\n');
  }
  const blocked = sandboxBlockedOperation(box.root, tapChildError());
  assert.equal(blocked, `open "${outside}" (EACCES)`);

  assert.equal(sandboxBlockedOperation(box.root, tapChildError({ code: 'EPERM_FAKE', messageCode: 'EACCES' })), null,
    'the structured code must exactly match the child error');
  assert.equal(sandboxBlockedOperation(box.root, tapChildError({ path: join(box.root, 'inside.txt') })), null,
    'the structured child path must match the resolved denied target');
  assert.equal(sandboxBlockedOperation(box.root, tapChildError({ extra: Array(65).fill('bounded continuation').join('\n') })), null,
    'an oversized error block is not classified');
  assert.equal(sandboxBlockedOperation(box.root, tapChildError(), { includeFilePaths: false }), null,
    'file-path classification remains disabled when requested');

  /** Build stderr-only Node fatal TAP while varying its proof fields. */
  function tapBareNodeError({ code = 'EPERM', syscall = 'listen', version = true, stack = true,
    footer = '1 !== 0', parentCode = 'ERR_ASSERTION', trailing = '', object = true, closeObject = true, exitProse = '' } = {}) {
    return [
      'TAP version 13',
      'not ok 1 - child listens',
      '  ---',
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      ...(exitProse ? [`    ${exitProse}`] : []),
      '    Error: listen EPERM: operation not permitted 127.0.0.1:0',
      ...(stack ? ['        at Server.listen (node:net:2000:7)'] : []),
      ...(object ? ['        {', `          code: '${code}',`, `          syscall: '${syscall}',`,"          address: '127.0.0.1',",'          port: 0', ...(closeObject ? ['        }'] : [])] : []),
      ...(version ? ['    Node.js v22.22.2'] : []),
      ...(trailing ? [`    ${trailing}`] : []),
      '',
      `    ${footer}`,
      `  code: '${parentCode}'`,
      '  ...',
    ].join('\n');
  }
  assert.equal(sandboxBlockedOperation(box.root, tapBareNodeError()), 'listen (EPERM)',
    'bare stderr remains recognizable when the Node fatal fields and assertion prove nonzero exit');
  for (const [label, options] of [
    ['missing stack', { stack: false }],
    ['missing Node version', { version: false }],
    ['missing structured error fields', { object: false }],
    ['truncated structured object', { closeObject: false }],
    ['mismatched structured code', { code: 'EACCES' }],
    ['mismatched structured syscall', { syscall: 'open' }],
    ['non-assertion parent', { parentCode: 'ERR_TEST_FAILURE' }],
    ['zero exit footer', { footer: '0 !== 0' }],
    ['zero child-exit prose cannot fall back to footer', { exitProse: 'App exited before listening (code 0, signal null):' }],
    ['invalid child-exit prose cannot fall back to footer', { exitProse: 'App exited before listening (code unknown, signal null):' }],
    ['unrelated trailing error', { trailing: 'Error: later ordinary failure' }],
  ]) {
    assert.equal(sandboxBlockedOperation(box.root, tapBareNodeError(options)), null, `${label} stays unclassified`);
  }
});

/** Project-declared static guards reject unchanged-gate import regressions before costly proof. */
test('a submit runs the static style checks first [C7]', t => {
  let box = privateRepo(t);
  const marker = join(box.dir, 'item-check-ran');
  box.env.ITEM_CHECK_MARKER = marker;
  const check = 'node -e "require(\'node:fs\').writeFileSync(process.env.ITEM_CHECK_MARKER, \'ran\')"';
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node -e "process.exit(0)"',
    affectedTests: 'node --test', submitGate: 'landing', staticChecks: 'node test/static-style-check.mjs',
    spec: 'SPEC.md', verify: 'any', lease: '2h', shared: ['pullboard.json'] }));
  put(box.root, 'src/cli.js', "import { join } from 'node:path';\nexport const fixture = join;\n");
  const oracle = new URL('./import-style-helpers.js', import.meta.url).href;
  put(box.root, 'test/static-style-check.mjs', [
    "import { readFileSync } from 'node:fs';",
    `import { importStyleViolations } from ${JSON.stringify(oracle)};`,
    "const file = 'src/cli.js';",
    "const errors = importStyleViolations([{ file, source: readFileSync(file, 'utf8') }]);",
    "for (const row of errors) console.error(`${row.file}:${row.line}: one import binding per line`);",
    'process.exit(errors.length ? 1 : 0);',
  ].join('\n'));
  commitAll(box);
  box = builderRepo(box);
  const added = box.coordinator('add', 'build', 'Static style before proof', '--check', check);
  assert.equal(added.code, 0, added.err);
  assert.equal(box.run('claim', '1').code, 0);
  const candidateConfig = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  candidateConfig.staticChecks = '';
  put(box.root, 'pullboard.json', JSON.stringify(candidateConfig));
  put(box.root, 'src/cli.js', "import { join, resolve } from 'node:path';\nexport const fixture = join;\n");
  commitAll(box, 'feat(core): expose the missed static guard [G1]');
  rmSync(marker, { force: true });
  const submitted = box.run('submit', '1', '--json', '--infra', 'the static guard fixture edits its pullboard.json');
  assert.notEqual(submitted.code, 0, 'submit must refuse a static import violation before any item proof');
  assert.match(submitted.out + submitted.err, /src\/cli\.js:1: one import binding per line/u);
  assert.equal(existsSync(marker), false, 'the frozen item check must not run after an early static refusal');
  assert.equal(JSON.parse(box.run('show', '1', '--json').out).item_status, 'claimed');
  const checked = box.run('check', '1', '--yes', '--json');
  assert.notEqual(checked.code, 0, 'an explicit check must run the same accepted project guard first');
  assert.match(checked.out + checked.err, /src\/cli\.js:1: one import binding per line/u);
  assert.equal(existsSync(marker), false, 'neither a submit nor a check bypasses the failed static guard');
});
