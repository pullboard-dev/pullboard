/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/**
 * An ordinary child failure stays gate red, and scanner-unknown denials stay ordinary [C7,B26]
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitSettled } from './local.js';
import { join } from 'node:path';
import { sandboxBlockedOperation } from '../../../../../packages/gate/index.js';
import { fileDenialWatcher } from '../../../../../packages/sandbox/index.js';
import { runLocal } from './local.js';
import { childFailureSubmitBox } from '../../../tests/fixtures/submit/child-box.js';
import { pythonChildTap } from '../../../tests/fixtures/submit/child-box.js';
import { pythonPermissionError } from '../../../tests/fixtures/submit/child-box.js';

test('an ordinary failure stays gate red [C7,B26]', async (t) => {
  const source = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { listenerProbe } from '../src/listener-probe.js';",
    "test('ordinary failure', () => assert.equal(listenerProbe, 1));",
  ].join('\n');
  const box = await childFailureSubmitBox(t, source);
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
  const result = await submitSettled(t, box, (...args) => runLocal(box, ...args));
  const output = `${result.out}\n${result.err}`;
  assert.equal(result.code, 1, output); // The pulled gate came back red.
  assert.match(output, /not ok 1 - ordinary failure/u, 'the receipt carries the failing proof');
  assert.doesNotMatch(output, /SANDBOX_BLOCKED/u);
});
