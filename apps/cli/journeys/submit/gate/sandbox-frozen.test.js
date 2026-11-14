/** @pullboard-test-input source-tree */
/**
 * Frozen checks keep the sandbox refusal before submit proof: one slice of the submit gate proof, split from sandbox.test.js to stay under the runner time budget [I1,C7,#7725].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  refuseSandboxBlocked,
} from '../../../../../packages/gate/index.js';
import {
  checkAtCommit,
} from '../../../../runner/index.js';
import {
  coordinatorLocal,
  runLocal,
  submitWithEnv,
} from './local.js';
import {
  privateRepo,
  builderRepo,
  put,
  commitAll,
  seedGraph,
} from '../../../tests/fixtures/submit/gate.js';
import {
  test,
} from 'node:test';

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

test('frozen checks retain outside-file refusal before submit proof [I1,C7]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  box = builderRepo(box);
  // The pulled gate runs the frozen check in the runner's clone with a scrubbed environment, so each diagnostic is committed with the source; a check run here reads the environment first [C7,#7725].
  const fileCheck = 'node -e "const f=require(\'node:fs\');console.error(process.env.BLOCKED_DIAGNOSTIC??f.readFileSync(\'src/diag.txt\',\'utf8\'));process.exit(Number(process.env.BLOCKED_EXIT||f.readFileSync(\'src/exit.txt\',\'utf8\')))"';
  const added = await coordinatorLocal(box, 'add', 'build', 'Sandbox check', '--check', fileCheck);
  assert.equal(added.code, 0, added.err);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const outside = join(box.dir, 'outside.txt');
  /** Stage the check's diagnostic and exit code in this checkout's environment and in a new commit. */
  function stage(diagnostic, exit, message) {
    box.env.BLOCKED_DIAGNOSTIC = diagnostic;
    if (exit === undefined) delete box.env.BLOCKED_EXIT; else box.env.BLOCKED_EXIT = exit;
    put(box.root, 'src/diag.txt', diagnostic);
    put(box.root, 'src/exit.txt', exit ?? '1');
    commitAll(box, message);
  }
  stage(`Error: EACCES: permission denied, open '${outside}'`, undefined, 'feat(core): update selected source [G1]');
  blocked(await runLocal(box, 'check', '1', '--yes'), 'open');
  // A pulled submit queues its frozen check with the gate; the sandbox refusal is the settled gate receipt's failing part.
  const run = (...args) => runLocal(box, ...args);
  const blockedSubmit = await submitWithEnv(t, box, run);
  blocked(blockedSubmit, 'open');
  const checkPhase = blockedSubmit.receipt.gate.phases.find(phase => phase.role === 'check');
  assert.ok(JSON.stringify(checkPhase).includes(outside), 'the exact refused path remains in the gate receipt\'s check phase');
  stage('AssertionError [ERR_ASSERTION]: ordinary assertion', undefined, 'feat(core): stage an ordinary failure [G1]');
  const ordinary = await submitWithEnv(t, box, run);
  assert.equal(ordinary.code, 1);
  assert.doesNotMatch(ordinary.err, /SANDBOX_BLOCKED/u);
  stage('AssertionError [ERR_ASSERTION]: ordinary assertion', '0', 'feat(core): stage a passing check [G1]');
  assert.equal((await submitWithEnv(t, box, run)).code, 0, 'the unchanged check can pass when the operation is allowed');
  const item = JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out);
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
  assert.equal(JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out).item_status, 'submitted', 'checks alone record no verdict');
});
