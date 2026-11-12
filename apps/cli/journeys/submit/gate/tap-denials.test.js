/** @pullboard-test-input source-tree */
/**
 * Nested TAP child denials need bounded matching fatal details: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  join,
} from 'node:path';
import {
  sandboxBlockedOperation,
} from '../../../../../packages/gate/index.js';
import {
  privateRepo,
} from '../../../tests/fixtures/submit/gate.js';
import {
  test,
} from 'node:test';

test('nested TAP child denials require bounded matching fatal details [C7,B26]', async (t) => {
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
