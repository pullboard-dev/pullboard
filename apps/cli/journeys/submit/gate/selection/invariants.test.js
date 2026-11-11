/** @pullboard-test-input source-tree */
/**
 * A landing-gated submit runs the project's invariant tests [V4,C7].
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
    put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 1;\n');
    commitAll(box);
    box = builderRepo(box, ['apps/cli/src/io/run/tests.js']);
    assert.equal(box.coordinator('add', 'build', 'Invariant fixture', '--check', 'node -e "process.exit(0)"').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    return { box, marker };
  }
  /** A global edit exercises the uncertain-selector path without running a full suite. */
  function change(box, global = true) {
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    if (global) put(box.root, 'apps/cli/src/io/run/tests.js', 'export const version = 2;\n');
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
