/** @pullboard-test-input source-tree */
/**
 * A red gate shows what it said, and submit runs the frozen item check and affected test only [C7,V4,V10,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureGit,
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
import { privateRepo } from '../../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../../tests/fixtures/submit/gate.js';
import { put } from '../../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../../tests/fixtures/submit/gate.js';

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
