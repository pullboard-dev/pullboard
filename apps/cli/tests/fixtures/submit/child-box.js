/** Shared fixture: a claimed submit box whose gate selects a nested child-process test, split out of selection.test.js to keep each journey file inside its time budget [C7,B26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { privateRepo } from './gate.js';
import { builderRepo } from './gate.js';
import { put } from './gate.js';
import { commitAll } from './gate.js';
import { SPEC } from './gate.js';
import { coordinatorLocal } from './local.js';
import { runLocal } from './local.js';

/** Build a claimed submit fixture whose changed source selects a nested child-process test; deniedFile names the path a Python-style denial reports. */
export async function childFailureSubmitBox(t, testSource, { deniedFile = null } = {}) {
  let box = privateRepo(t);
  // Set before the first board command: that command starts the machine's local runner, whose jobs inherit only FIXTURE_ names.
  if (deniedFile) box.env.FIXTURE_CHILD_PERMISSION_PATH = join(box.dir, deniedFile);
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
  box.env.FIXTURE_LISTEN_DENIAL_SHIM = join(box.root, 'test/listen-denial.js');
  put(box.root, 'test/child-listener.test.js', testSource);
  commitAll(box);
  box = builderRepo(box);
  const added = await coordinatorLocal(box, 'add', 'build', 'Child-process gate fixture', '--check', 'true');
  assert.equal(added.code, 0, added.err);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/listener-probe.js', 'export const listenerProbe = 2;\n');
  commitAll(box, 'feat(core): change listener probe [G1]');
  return box;
}

/** Produce a real TAP failure containing a nested child's EPERM without relying on host sandbox support. */
export function childListenerTestSource() {
  return [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import '../src/listener-probe.js';",
    "test('the server child binds', () => {",
    "  const child = spawnSync(process.execPath, ['--import', process.env.FIXTURE_LISTEN_DENIAL_SHIM, '--input-type=module', '-e', \"import { createServer } from 'node:net'; createServer().listen(0, '127.0.0.1');\"], { encoding: 'utf8' });",
    "  assert.equal(child.status, 0, `App exited before listening (code ${child.status}, signal ${child.signal}):\\n${child.stderr}`);",
    '});',
  ].join('\n');
}

/** Produce a child-process test whose stderr models a Python traceback without requiring Python. */
export function childPythonTestSource() {
  const childProgram = [
    'console.error("Traceback (most recent call last):")',
    'console.error("  File " + JSON.stringify("child.py") + ", line 1, in <module>")',
    'console.error("PermissionError: [Errno 13] Permission denied: " + JSON.stringify(process.env.FIXTURE_CHILD_PERMISSION_PATH))',
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
export function pythonPermissionError(path, errno = 13) {
  return `PermissionError: [Errno ${errno}] Permission denied: '${path}'`;
}

/** Wrap scanner input in a failed child TAP record with or without a fatal traceback. */
export function pythonChildTap(path, { traceback = true, frame = true, prefixMarker = false, errno = 13, wrapper = true, exitCode = 1, trailingError = false, assertionFooter = null, footerSeparator = '\n\n\n', parentCode = 'ERR_ASSERTION' } = {}) {
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

