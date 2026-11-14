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
  runLocal,
} from './local.js';
import {
  privateRepo,
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
});
