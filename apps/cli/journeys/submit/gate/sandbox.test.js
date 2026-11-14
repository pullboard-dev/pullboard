/** @pullboard-test-input source-tree */
/**
 * The sandbox-blocked gate asks the person: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
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
  await t.test('full gates distinguish listener denial from ordinary failures [I1,C7]', async () => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: command }));
    seedGraph(box);
    box.env.BLOCKED_DIAGNOSTIC = 'Error: listen EPERM: operation not permitted 127.0.0.1:0';
    blocked(await runLocal(box, 'gate'), 'listen');
    const log = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate.log'));
    assert.match(readFileSync(log, 'utf8'), /Error: listen EPERM/u, 'the original diagnostic is retained');
    assert.ok(existsSync(log + '.profile.json'), 'ordinary timings are retained');
    box.env.BLOCKED_DIAGNOSTIC = 'Error: bind EACCES: permission denied 127.0.0.1:0';
    blocked(await runLocal(box, 'gate'), 'bind');
    for (const diagnostic of [
      'AssertionError [ERR_ASSERTION]: expected EPERM when listen was called',
      'Error: listen EADDRINUSE: address already in use',
      `Error: EACCES: permission denied, open '${join(box.root, 'inside.txt')}'`,
    ]) {
      box.env.BLOCKED_DIAGNOSTIC = diagnostic;
      const ordinary = await runLocal(box, 'gate');
      assert.equal(ordinary.code, 1, ordinary.out + ordinary.err);
      assert.doesNotMatch(ordinary.out + ordinary.err, /SANDBOX_BLOCKED/u);
      assert.match(ordinary.out, /gate red/u);
    }
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node -e "require(\'node:assert/strict\').fail(\'ordinary assertion\')"' }));
    commitAll(box);
    const assertion = await runLocal(box, 'gate');
    assert.equal(assertion.code, 1);
    assert.match(assertion.out, /AssertionError/u);
    assert.doesNotMatch(assertion.out + assertion.err, /SANDBOX_BLOCKED/u);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: command }));
    commitAll(box);
    box.env.BLOCKED_DIAGNOSTIC = 'Error: listen EPERM: operation not permitted';
    box.env.BLOCKED_EXIT = '0';
    const green = await runLocal(box, 'gate');
    assert.equal(green.code, 0, green.err);
    assert.doesNotMatch(green.out + green.err, /SANDBOX_BLOCKED/u, 'a successful diagnostic is not a refusal');
  });
  await t.test('module-startup outside-file denials preserve fatal TAP evidence [I1,C7]', async (t) => {
    const box = privateRepo(t);
    const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../../../../../apps/cli/src/io/run/tests.js'))} test/permission.test.js`;
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
      const result = await runLocal(box, 'gate');
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
    const allowed = await runLocal(box, 'gate');
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
    assert.equal(readFileSync(outside, 'utf8'), 'blocked during module evaluation');
  });
  await t.test('frozen checks retain outside-file refusal before submit proof [I1,C7]', async () => {
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
    blocked(await submitWithEnv(t, box, run), 'open');
    const log = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-submit.log.check.log'));
    assert.ok(readFileSync(log, 'utf8').includes(outside), 'the exact refused path remains in the raw log');
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
});
