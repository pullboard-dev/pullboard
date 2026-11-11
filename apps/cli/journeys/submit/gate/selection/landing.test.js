/** @pullboard-test-input source-tree */
/**
 * A landing-gated project defers the full suite from submit to landing [V4,C7].
 */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../../../tests/fixtures/child.js';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { privateRepo } from '../../../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../../../tests/fixtures/submit/gate.js';
import { put } from '../../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../../../tests/fixtures/submit/gate.js';

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
    put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 1;\n');
    commitAll(box, 'chore(core): prepare landing-gate fixture');
    box = builderRepo(box, ['apps/cli/src/io/run/tests.js']);
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
  put(optedIn.box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
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
  put(candidateOnly.box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
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
