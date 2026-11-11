/** @pullboard-test-input source-tree */
/**
 * Submit proves its frozen item check and the import closure its change can reach; only a full
 * selection can stand in for the project gate, which still runs at landing [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  runFixtureChild,
  runFixtureGit,
} from '../../../tests/fixtures/child.js';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { configFromSource } from '../../../../../packages/config/index.js';
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

  for (const path of ['apps/cli/src/io/run/tests.js', 'package.json', 'package-lock.json']) {
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
    put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 1;\n');
    commitAll(box, 'chore(core): prepare landing-gate fixture');
    box = builderRepo(box, ['apps/cli/src/io/run/tests.js']);
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
  put(optedIn.box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
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
  put(candidateOnly.box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
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
    put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 1;\n');
    commitAll(box);
    box = builderRepo(box, ['apps/cli/src/io/run/tests.js']);
    assert.equal(box.coordinator('add', 'build', 'Invariant fixture', '--check', 'node -e "process.exit(0)"').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    return { box, marker };
  }
  /** A global edit exercises the uncertain-selector path without running a full suite. */
  function change(box, global = true) {
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    if (global) put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
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
