/** @pullboard-test-input source-tree */
/**
 * Real outside-file TAP denials refuse while permission assertions stay ordinary: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
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

test('real outside-file TAP denials refuse while permission assertions stay ordinary [I1,C7]', async (t) => {
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
  await t.test('real outside-file TAP denials refuse while permission assertions stay ordinary [I1,C7]', async () => {
    let box = privateRepo(t);
    const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../../../../../apps/cli/src/io/run/tests.js'))} test/permission.test.js`;
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
    assert.equal((await coordinatorLocal(box, 'add', 'build', 'Real permission check', '--check', runner)).code, 0);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    const item = { ...JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out), item_commit: box.git('rev-parse', 'HEAD').trim() };
    try {
      assert.throws(() => writeFileSync(outside, 'sentinel'), { code: 'EACCES' }, 'the operating system actually denies this write');
      blocked(await runLocal(box, 'gate'), outside);
      blocked(await runLocal(box, 'check', '1', '--yes'), outside);
      blocked(await runLocal(box, 'submit', '1'), outside);
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
      const ordinary = await runLocal(box, 'gate');
      assert.equal(ordinary.code, 1);
      assert.match(ordinary.out, /ERR_ASSERTION/u);
      assert.doesNotMatch(ordinary.out + ordinary.err, /SANDBOX_BLOCKED/u);
      const printedDiagnostic = `Error: EACCES: permission denied, open '${outside}'`;
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion prints a permission-looking diagnostic', () => { console.error(${JSON.stringify(printedDiagnostic)}); assert.equal(1, 2); });\n`);
      commitAll(box);
      const printedAssertion = await runLocal(box, 'gate');
      assert.equal(printedAssertion.code, 1);
      assert.doesNotMatch(printedAssertion.out + printedAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(printedAssertion.out, /ERR_ASSERTION/u);
      assert.match(printedAssertion.out, /# Error: EACCES: permission denied/u, 'TAP retains the test diagnostic as a comment');
      const multilineDiagnostic = `ordinary assertion detail\nError: EACCES: permission denied, open '${outside}'`;
      put(box.root, 'test/permission.test.js', prefix + `test('multiline assertion detail contains a permission-looking line', () => { assert.fail(${JSON.stringify(multilineDiagnostic)}); });\n`);
      commitAll(box);
      const multilineAssertion = await runLocal(box, 'gate');
      assert.equal(multilineAssertion.code, 1);
      assert.doesNotMatch(multilineAssertion.out + multilineAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(multilineAssertion.out, /ERR_ASSERTION/u);
      assert.match(multilineAssertion.out, /Error: EACCES: permission denied/u);
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion logs a caught OS error', () => { try { ${operation}; } catch (error) { console.error(error); } assert.equal(1, 2); });\n`);
      commitAll(box);
      const caughtAssertion = await runLocal(box, 'gate');
      assert.equal(caughtAssertion.code, 1);
      assert.doesNotMatch(caughtAssertion.out + caughtAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(caughtAssertion.out, /ERR_ASSERTION/u);
      put(box.root, 'test/permission.test.js', denied);
      commitAll(box);
    } finally { chmodSync(directory, 0o700); }
    const allowed = await runLocal(box, 'gate');
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
    assert.equal(readFileSync(outside, 'utf8'), 'blocked', 'the unchanged real write succeeds when access is restored');
  });
});
