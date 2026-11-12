/** A failure signature keys on error type plus the deepest repository frame and ignores per-run spelling [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureSignature } from '../../../index.js';

const JOB_A = '/Users/example/.pullboard-runner/jobs/8f31c0de-1111-4a2b-9c3d-0123456789ab/checkout';
const JOB_B = '/home/example/pullboard-runner/jobs/00aa77bb-2222-4c4c-8d8d-fedcba987654/checkout';
const NODE_TAIL = 'Test.runInAsyncScope (node:async_hooks:214:14)\nTest.run (node:internal/test_runner/test:1047:25)';

/** The real device sign-in assertion as node:test prints it, run in one checkout. */
function signIn(checkout, { line = 457, column = 22 } = {}) {
  return {
    name: 'AssertionError', code: 'ERR_ASSERTION', operator: 'strictEqual',
    error: 'real device sign-in links the board\n\n1 !== 0\n',
    stack: `assertLinked (file://${checkout}/apps/cli/tests/fixtures/relay/client.js:${line}:${column})\n`
      + `TestContext.<anonymous> (file://${checkout}/apps/cli/journeys/relay/device.test.js:30:5)\n${NODE_TAIL}`,
  };
}

/** An ENOENT on a temp path, thrown from the repository's own reader. */
function enoent(temp, checkout) {
  return {
    code: 'ENOENT', error: `ENOENT: no such file or directory, open '${temp}/state.json'`,
    stack: `Object.openSync (node:fs:560:18)\nreadFileSync (node:fs:444:35)\n`
      + `readState (file://${checkout}/packages/state/src/io/read.js:12:20)\n${NODE_TAIL}`,
  };
}

test('the same assertion in different runner job directories has one signature [C7]', () => {
  const first = failureSignature(signIn(JOB_A));
  const second = failureSignature(signIn(JOB_B, { line: 460, column: 9 }));
  assert.equal(first, second);
  assert.equal(first, 'AssertionError:ERR_ASSERTION:strictEqual @ apps/cli/tests/fixtures/relay/client.js#assertLinked');
});

test('absolute checkout, worktree and root paths all reduce to the repository path [C7]', () => {
  const base = failureSignature(signIn(JOB_A));
  const root = '/Users/me/Code/pullboard';
  assert.equal(failureSignature({ ...signIn(root), root }), base);
  assert.equal(failureSignature(signIn('/Users/me/Code/pullboard/.claude/worktrees/agent-af68fb96cfbd05743')), base);
  assert.equal(failureSignature({ ...signIn(JOB_A), stack: signIn(JOB_A).stack.replaceAll('file://', '') }), base);
});

test('ENOENT on different temp paths and job dirs has one signature that names the code and frame [C7]', () => {
  const first = failureSignature(enoent('/var/folders/ab/cdefgh/T/pullboard-state-Ab12Cd', JOB_A));
  const second = failureSignature(enoent('/tmp/pullboard-state-Zz98Yx', JOB_B));
  assert.equal(first, second);
  assert.equal(first, 'Error:ENOENT @ packages/state/src/io/read.js#readState');
});

test('hashes, ports, durations and numbers in the text never reach the signature [C7]', () => {
  const noisy = (n) => ({ error: `boom after ${n}ms on 127.0.0.1:${40000 + n} for ${'ab12cd34'.repeat(5)}`, stack: `run (file://${JOB_A}/packages/x/src/run.js:${n}:1)` });
  assert.equal(failureSignature(noisy(12)), failureSignature(noisy(987)));
});

test('a refusal keys on its rule code [C7]', () => {
  const refused = (code, next) => ({ name: 'Refused', error: `[${code}] ${next}`, stack: `claim (file://${JOB_A}/packages/moves/src/claim.js:9:11)` });
  assert.equal(failureSignature(refused('SELF_VERIFY', 'ask another agent in 30 s')), 'Refused[SELF_VERIFY] @ packages/moves/src/claim.js#claim');
  assert.notEqual(failureSignature(refused('SELF_VERIFY', 'x')), failureSignature(refused('NOT_JOINED', 'x')));
});

test('different root causes get different signatures [C7]', () => {
  const base = signIn(JOB_A);
  const otherFrame = { ...base, stack: base.stack.replace('assertLinked', 'assertSeated').replace('relay/client.js', 'relay/seat.js') };
  const otherType = { ...base, name: 'TypeError', code: undefined, operator: undefined };
  const otherFunction = { ...base, stack: base.stack.replace('assertLinked', 'assertOther') };
  const sigs = new Set([base, otherFrame, otherType, otherFunction].map(failureSignature));
  assert.equal(sigs.size, 4);
});

test('the deepest repository frame wins over node internals and dependencies [C7]', () => {
  const stack = `Module._compile (node:internal/modules/cjs/loader:1:1)\nparse (file://${JOB_A}/node_modules/dep/index.js:3:3)\n`
    + `inner (file://${JOB_A}/packages/a/src/inner.js:5:5)\nouter (file://${JOB_A}/packages/a/src/outer.js:8:8)`;
  assert.equal(failureSignature({ error: 'x', stack }), 'Error @ packages/a/src/inner.js#inner');
});

test('anonymous frames, async and method prefixes keep one function name [C7]', () => {
  const at = (frame) => failureSignature({ error: 'x', stack: frame });
  assert.equal(at(`TestContext.<anonymous> (file://${JOB_A}/t/a.test.js:1:1)`), 'Error @ t/a.test.js#<anonymous>');
  assert.equal(at(`async Object.load (file://${JOB_A}/t/a.test.js:1:1)`), 'Error @ t/a.test.js#load');
  assert.equal(at(`file://${JOB_A}/t/a.test.js?cache=17:4:2`), 'Error @ t/a.test.js#<anonymous>');
});

test('a failure with no repository frame has no signature [C7]', () => {
  assert.equal(failureSignature({ error: 'x', stack: 'Test.run (node:internal/test_runner/test:1:1)' }), null);
  assert.equal(failureSignature({ error: 'x' }), null);
});
