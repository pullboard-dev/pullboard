/** @pullboard-test-input source-tree */
/**
 * A red gate shows what it said, and submit runs the frozen item check and affected test only [C7,V4,V10,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
} from '../../../../tests/fixtures/child.js';
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
import { SPEC } from '../../../../tests/fixtures/submit/gate.js';
import { coordinatorLocal } from '../local.js';
import { runLocal } from '../local.js';
import { submitWithEnv } from '../local.js';
import { privateRepo } from '../../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../../tests/fixtures/submit/gate.js';
import { put } from '../../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../../tests/fixtures/submit/gate.js';

/** A failed project command keeps its first diagnostic even when later output is unstructured. */
test('a red gate on submit shows what the gate said [C7,V10]', async (t) => {
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
    const added = await coordinatorLocal(box, 'add', 'build', 'Show the gate diagnostic');
    assert.equal(added.code, 0, added.err);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/RED', 'red\n');
    commitAll(box, 'feat(core): exercise gate output [G1]');
    const submitted = await submitWithEnv(t, box, (...args) => runLocal(box, ...args));
    assert.notEqual(submitted.code, 0);
    // The settled answer's last line is the gate job's own receipt; the lines before it are the refusal's text.
    const refusal = { message: submitted.err.split('\n').slice(0, -1).join('\n') };
    assert.ok(refusal.message.includes(first), `the first diagnostic must survive the bounded refusal: ${JSON.stringify(refusal)}`);
    assert.match(refusal.message, /\d+ nonempty output lines omitted/u);
    assert.ok(refusal.message.length < 5000, 'a refusal must remain bounded');
    // The pulled gate keeps the complete output as the runner's proof.log; its receipt names that log and the bytes it holds.
    const proof = submitted.receipt.gateJob.gate.phases.find(phase => phase.role === 'proof');
    assert.equal(proof.kept, 'proof.log', 'the complete gate output remains available in its log');
    assert.ok(proof.bytes > 8000, 'the kept log holds all eighty detail lines');
    assert.equal(JSON.parse((await runLocal(box, 'show', '1', '--json')).out).item_status, 'claimed');
  }
});

test('submit runs the frozen check and affected test only; landing and explicit gate remain full [V4,C7,V16]', async (t) => {
  let box = privateRepo(t);
  const checkCommand = 'node -e "require(\'node:fs\').appendFileSync(process.env.FIXTURE_ITEM_CHECK_MARKER, \'check\')"';
  const checkMarker = join(box.dir, 'item-check.log');
  box.env.FIXTURE_ITEM_CHECK_MARKER = checkMarker;
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', spec: 'SPEC.md', verify: 'any', lease: '2h' }, null, 2));
  put(box.root, 'SPEC.md', SPEC);
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { value } from '../src/a.js';",
    "appendFileSync(process.env.FIXTURE_AFFECTED_MARKER, 'affected\\n');",
    "assert.equal(value, 2);",
  ].join('\n'));
  put(box.root, 'test/b.test.js', [
    "import assert from 'node:assert/strict';",
    "assert.fail('independent test must not block this submit');",
  ].join('\n'));
  commitAll(box);
  box = builderRepo(box);
  // --wait holds add until the check's baseline job has run at main: that job appends to the same marker, and one still
  // queued when the marker is cleared below ran after it, so the marker read 'checkcheck' though the gate ran its check once [#7530].
  const added = await coordinatorLocal(box, 'add', 'build', 'Source change', '--check', checkCommand, '--wait');
  assert.equal(added.code, 0, added.err);
  assert.notEqual(JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out).item_check_baseline?.result, 'pending', 'the baseline settled before the marker is cleared');
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);

  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'affected-ran.log');
  box.env.FIXTURE_AFFECTED_MARKER = marker;
  rmSync(checkMarker, { force: true });
  const stamp = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
  writeFileSync(stamp, 'forged-stamp-must-not-change\n');

  const submitted = await submitWithEnv(t, box, (...args) => runLocal(box, ...args));
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const receipt = submitted.receipt;
  assert.equal(receipt.id, 1);
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.gate.green, true);
  assert.equal(receipt.gate.full, false);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
  // The pulled receipt has no `reason`; its equivalent is that nothing widened or deferred the selection: the report names exactly the affected file.
  assert.equal(receipt.gate.deferred, false);
  assert.equal(receipt.gate.deferNote, undefined);
  assert.equal(receipt.gate.report, 'affected tests: test/a.test.js');
  assert.equal(receipt.gate.check.command, checkCommand);
  assert.equal(receipt.gate.check.green, true);
  assert.ok(existsSync(checkMarker), 'submit executes the item check rather than merely reporting it');
  assert.equal(readFileSync(checkMarker, 'utf8'), 'check', 'the frozen item check actually ran at submit');
  assert.ok(existsSync(marker), 'submit executes the selected test rather than merely reporting it');
  assert.equal(readFileSync(marker, 'utf8'), 'affected\n', 'submit really ran the selected test despite the full-gate stamp');
  assert.equal(readFileSync(stamp, 'utf8'), 'forged-stamp-must-not-change\n', 'subset proof never writes the full-gate stamp');

  rmSync(stamp);
  const explicit = await runLocal(box, 'gate');
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
