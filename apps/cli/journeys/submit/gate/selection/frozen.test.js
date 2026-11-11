/** @pullboard-test-input source-tree */
/**
 * Submit runs the frozen item check and defers the full suite to landing [V4,C7,V16].
 */
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
import { seedGraph } from '../../../../tests/fixtures/submit/gate.js';

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

test('a landing-gated project defers the full suite from submit to landing [V4,C7]', (t) => {
  /** Build a small project whose global-source edit selects the full gate.
   * @param {string} [initialSubmitGate]
   * @returns {{box: any, fullMarker: string, checkMarker: string}}
   */
  function project(initialSubmitGate) {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({
      gate: 'node --test', affectedTests: 'node --test', shared: ['pullboard.json'],
      ...(initialSubmitGate ? { submitGate: initialSubmitGate } : {}),
    }));
    seedGraph(box);
    const fullMarker = join(box.dir, 'full-suite.log');
    const checkMarker = join(box.dir, 'item-check.log');
    box.env.FULL_SUITE_MARKER = fullMarker;
    box.env.ITEM_CHECK_MARKER = checkMarker;
    for (const [file, name] of [['a', 'first'], ['b', 'second'], ['c', 'third']]) {
      put(box.root, `test/${file}.test.js`, [
        "import { appendFileSync } from 'node:fs';",
        ...(file === 'a' ? ["import '../src/entry.js';"] : []),
        `appendFileSync(process.env.FULL_SUITE_MARKER, '${name}\\n');`,
      ].join('\n') + '\n');
    }
    put(box.root, 'packages/gate/src/io/run/tests.js', 'export const version = 1;\n');
    commitAll(box, 'chore(core): prepare landing-gate fixture');
    box = builderRepo(box, ['packages/gate/src/io/run/tests.js']);
    const check = `node -e "require('node:fs').appendFileSync(process.env.ITEM_CHECK_MARKER, 'check\\n')"`;
    assert.equal(box.coordinator('add', 'build', 'Landing gate fixture', '--check', check).code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    rmSync(fullMarker, { force: true });
    rmSync(checkMarker, { force: true });
    return { box, fullMarker, checkMarker };
  }

  const optedIn = project();
  const mainRoot = join(optedIn.box.dir, 'repo');
  const mainConfig = JSON.parse(readFileSync(join(mainRoot, 'pullboard.json'), 'utf8'));
  mainConfig.submitGate = 'landing';
  put(mainRoot, 'pullboard.json', JSON.stringify(mainConfig));
  runFixtureGit(['add', 'pullboard.json'], { cwd: mainRoot, env: optedIn.box.env });
  runFixtureGit(['commit', '-q', '-m', 'feat(config): defer full suite to landing [G1]'], { cwd: mainRoot, env: optedIn.box.env });
  optedIn.box.git('merge', '--no-edit', 'main');
  put(optedIn.box.root, 'packages/gate/src/io/run/tests.js', 'export const version = 2;\n');
  commitAll(optedIn.box, 'feat(core): change global source [G1]');

  const deferred = optedIn.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(deferred.code, 0, deferred.err);
  const receipt = JSON.parse(deferred.out);
  assert.equal(receipt.gate.full, true, 'the selector still reports that it fell back to the whole suite');
  assert.equal(receipt.gate.deferred, true);
  assert.match(receipt.gate.report, /full suite deferred to the landing gate/u);
  assert.ok(existsSync(optedIn.checkMarker), 'the item check still runs');
  assert.equal(existsSync(optedIn.fullMarker), false, 'the submit did not run the deferred suite');
  const shown = optedIn.box.run('show', '1', '--json');
  assert.equal(shown.code, 0, shown.err);
  const submitEvent = JSON.parse(shown.out).thread.findLast((event) => event.kind === 'submit');
  assert.equal(submitEvent.detail.note, 'full suite deferred to the landing gate', 'the reviewer can see the durable submission note');
  const stamp = resolve(optedIn.box.root, optedIn.box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
  assert.equal(existsSync(stamp), false, 'deferral never creates a full-gate stamp');

  const landing = optedIn.box.run('gate', '--landing');
  assert.equal(landing.code, 0, landing.err);
  assert.deepEqual(readFileSync(optedIn.fullMarker, 'utf8').trim().split('\n').sort(), ['first', 'second', 'third'],
    'the landing gate runs the full configured suite');
  assert.ok(existsSync(stamp), 'only the actual full-suite pass stamps the tree');

  const candidateOnly = project();
  const candidateConfig = JSON.parse(readFileSync(join(candidateOnly.box.root, 'pullboard.json'), 'utf8'));
  candidateConfig.submitGate = 'landing';
  put(candidateOnly.box.root, 'pullboard.json', JSON.stringify(candidateConfig));
  put(candidateOnly.box.root, 'packages/gate/src/io/run/tests.js', 'export const version = 2;\n');
  commitAll(candidateOnly.box, 'feat(core): try candidate-only deferral [G1]');
  const ordinary = candidateOnly.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(ordinary.code, 0, ordinary.err);
  const ordinaryReceipt = JSON.parse(ordinary.out);
  assert.equal(ordinaryReceipt.gate.deferred, false, 'a candidate-only setting is not trusted');
  assert.ok(existsSync(candidateOnly.fullMarker), 'without current-main opt-in the full suite still runs at submit');
  const ordinaryEvent = JSON.parse(candidateOnly.box.run('show', '1', '--json').out).thread.findLast((event) => event.kind === 'submit');
  assert.equal(ordinaryEvent.detail.note, undefined, 'ordinary submissions do not claim the suite was deferred');

  const named = project('landing');
  put(named.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(named.box, 'feat(core): change one selected source [G1]');
  const selected = named.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(selected.code, 0, selected.err);
  const selectedReceipt = JSON.parse(selected.out);
  assert.equal(selectedReceipt.gate.full, false);
  assert.equal(selectedReceipt.gate.deferred, true);
  assert.deepEqual(selectedReceipt.gate.files, ['test/a.test.js']);
  assert.match(selectedReceipt.gate.report, /affected tests: test\/a\.test\.js; full suite deferred to the landing gate/u);
  assert.ok(existsSync(named.checkMarker), 'the item check runs for a named selection');
  assert.equal(readFileSync(named.fullMarker, 'utf8'), 'first\n', 'the named affected test runs without unrelated tests');
  const namedEvent = JSON.parse(named.box.run('show', '1', '--json').out).thread.findLast((event) => event.kind === 'submit');
  assert.equal(namedEvent.detail.note, 'full suite deferred to the landing gate', 'the reviewer sees deferral for named affected tests too');
});

test("a landing-gated submit runs the project's invariant tests [V4,C7]", (t) => {
  /** Prepare accepted policy, then claim in a real separate builder checkout. */
  function project(invariants, failing = false) {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test',
      submitGate: 'landing', shared: ['pullboard.json'], ...(invariants === undefined ? {} : { submitInvariants: invariants }) }));
    seedGraph(box);
    const marker = join(box.dir, 'invariants.log');
    box.env.INVARIANT_MARKER = marker;
    put(box.root, 'test/invariant.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/a.js';",
      "appendFileSync(process.env.INVARIANT_MARKER, 'invariant\\n');",
      failing ? 'assert.equal(value, 1, "the project invariant stays enforced");' : 'assert.ok(value < 3);',
    ].join('\n') + '\n');
    put(box.root, 'test/a.test.js', "import '../src/entry.js';\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.INVARIANT_MARKER, 'selected\\n');\n");
    put(box.root, 'test/c.test.js', "throw new Error('unrelated test must stay deferred');\n");
    put(box.root, 'packages/gate/src/io/run/tests.js', 'export const version = 1;\n');
    commitAll(box);
    box = builderRepo(box, ['packages/gate/src/io/run/tests.js']);
    assert.equal(box.coordinator('add', 'build', 'Invariant fixture', '--check', 'node -e "process.exit(0)"').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    return { box, marker };
  }
  /** A global edit exercises the uncertain-selector path without running a full suite. */
  function change(box, global = true) {
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    if (global) put(box.root, 'packages/gate/src/io/run/tests.js', 'export const version = 2;\n');
    commitAll(box, 'feat(core): change invariant input [G1]');
  }
  /** A submit subset must never leave a full-gate stamp. */
  function unstamped(box) {
    const stamp = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate-green'));
    assert.equal(existsSync(stamp), false);
  }

  const empty = project();
  change(empty.box);
  const unchanged = empty.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(unchanged.code, 0, unchanged.err);
  assert.equal(existsSync(empty.marker), false, 'the empty default adds no tests');
  unstamped(empty.box);

  const mandatory = project(['test/invariant.test.js']);
  change(mandatory.box);
  const guarded = mandatory.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(guarded.code, 0, guarded.err);
  const guardedReceipt = JSON.parse(guarded.out);
  assert.equal(guardedReceipt.gate.full, true, 'the selector still reports an uncertain full fallback');
  assert.equal(guardedReceipt.gate.deferred, true);
  assert.deepEqual(guardedReceipt.gate.files, ['test/invariant.test.js'], 'receipt names only the executed invariant subset');
  assert.equal(readFileSync(mandatory.marker, 'utf8'), 'invariant\n', 'global fallback does not run unrelated selected/full tests');
  assert.match(guardedReceipt.gate.report, /submit invariants: test\/invariant\.test\.js; full suite deferred/u);
  unstamped(mandatory.box);

  const red = project(['test/invariant.test.js'], true);
  change(red.box);
  const refused = red.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.notEqual(refused.code, 0, 'a failing configured invariant must refuse the submit');
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.ok(existsSync(red.marker), 'the listed invariant actually ran');
  unstamped(red.box);

  const trusted = project([], true);
  const acceptedRoot = join(trusted.box.dir, 'repo');
  const policy = JSON.parse(readFileSync(join(acceptedRoot, 'pullboard.json'), 'utf8'));
  policy.submitInvariants = ['test/invariant.test.js'];
  put(acceptedRoot, 'pullboard.json', JSON.stringify(policy));
  runFixtureGit(['add', 'pullboard.json'], { cwd: acceptedRoot, env: trusted.box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: require project invariant'], { cwd: acceptedRoot, env: trusted.box.env });
  trusted.box.git('merge', '--no-edit', 'main');
  const candidate = JSON.parse(readFileSync(join(trusted.box.root, 'pullboard.json'), 'utf8'));
  candidate.submitInvariants = ['test/c.test.js'];
  put(trusted.box.root, 'pullboard.json', JSON.stringify(candidate));
  change(trusted.box);
  const ignored = trusted.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.notEqual(ignored.code, 0, 'accepted main policy overrides both the claim-time list and candidate edit');
  assert.match(ignored.err + ignored.out, /GATE_RED/u);
  assert.ok(existsSync(trusted.marker), 'the accepted-main invariant still ran');
  assert.doesNotMatch(ignored.err + ignored.out, /unrelated test must stay deferred/u);
  unstamped(trusted.box);

  const missing = project(['test/invariant.test.js']);
  rmSync(join(missing.box.root, 'test/invariant.test.js'));
  change(missing.box);
  const absent = missing.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.notEqual(absent.code, 0, 'deleting a mandatory file cannot make the guard disappear');
  assert.match(absent.err + absent.out, /submitInvariants file test\/invariant\.test\.js is missing or unreadable/u);
  unstamped(missing.box);

  const named = project(['test/invariant.test.js', 'test/invariant.test.js']);
  change(named.box, false);
  const selected = named.box.run('submit', '1', '--json', '--infra', 'the landing fixture edits its pullboard.json');
  assert.equal(selected.code, 0, selected.err);
  const receipt = JSON.parse(selected.out);
  assert.equal(receipt.gate.full, false);
  assert.equal(receipt.gate.deferred, true);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js', 'test/invariant.test.js']);
  assert.deepEqual(readFileSync(named.marker, 'utf8').trim().split('\n').sort(), ['invariant', 'selected'], 'selected and mandatory overlap runs once');
  assert.match(receipt.gate.report, /full suite deferred to the landing gate/u);
  unstamped(named.box);
});
