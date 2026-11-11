/** @pullboard-test-input source-tree */
/**
 * Submit proves its frozen item check and the import closure its change can reach; the sandbox-denial and selection cases [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { sandboxBlockedOperation } from '../../../../../packages/gate/index.js';
import { fileDenialWatcher } from '../../../../../packages/sandbox/index.js';
import { SPEC } from '../../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../tests/fixtures/submit/gate.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../../tests/fixtures/submit/gate.js';

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
    assert.ok(refusal.message.includes(first), `the first diagnostic must survive the bounded refusal: ${JSON.stringify(refusal)}`);
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

  for (const path of ['packages/gate/src/io/run/tests.js', 'package.json', 'package-lock.json']) {
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
