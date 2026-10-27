/** Landing reselects the actual merged batch, rather than trusting a submit's earlier subset [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { selectAffectedTests } from '../src/affected-tests.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { json } from './land-board-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A real Node test whose imported value must keep the specified contract. */
function valueTest(expected) {
  return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { value } from './value.js';\ntest('the imported value remains compatible', () => assert.equal(value, ${expected}));\n`;
}

/** Reject the actual merged importer, exercising either full fallback or the finite import subset. */
function affectedBatch(t, { stableBadges = false, inline = false, waive = false, opaque = false } = {}) {
  // The execution and waiver assertions inspect TAP; Node 22 and 24 have different default reporters.
  const box = e2e.project('node --test --test-reporter=tap web/*.test.js');
  // A fixture CLI is a fresh process, not the outer Node test worker. Admission markers stay intact.
  delete box.env.NODE_TEST_CONTEXT;
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, gate: inline ? (opaque ? '(node --test --test-reporter=tap web/floor.test.js)' : 'node --test --test-reporter=tap web/floor.test.js') : config.gate,
    affectedTests: 'node --test --test-reporter=tap', submitGate: 'landing',
    submitInvariants: ['web/floor.test.js'], submitDeferAbove: 20, landing: inline ? {} : { publish: 'separate' },
    verify: { policy: 'any', unrelatedTrunkMoves: true } }, null, 2) + '\n');
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/value.test.js'), valueTest(1));
  writeFileSync(join(box.repo, 'web/floor.test.js'), "import { test } from 'node:test';\ntest('the fixed quick guard remains green', () => {});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: prepare affected landing fixture');
  if (inline) {
    const remote = join(box.dir, 'private-origin.git');
    box.git(box.dir, 'init', '-q', '--bare', remote);
    box.git(box.repo, 'remote', 'add', 'origin', remote);
    box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  }
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const item = json(box, box.repo, 'add', 'web', 'Change the value and its test', '--specs', 'G1',
    '--criterion', 'the changed value passes its test', '--check', 'node --test --test-reporter=tap web/value.test.js').item.item_id;
  assert.equal(box.run(box.web, 'claim', String(item)).code, 0);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value = 2;\n');
  writeFileSync(join(box.web, 'web/value.test.js'), valueTest(2));
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): update the value and its test [G1]');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = box.run(box.web, 'submit', String(item));
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const checkLog = box.git(box.web, 'rev-parse', '--git-path', 'pullboard-submit.log.check.log');
  assert.match(readFileSync(resolve(box.web, checkLog), 'utf8'), /# tests 1\b/u, 'submit really executes its frozen test');
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const verified = box.run(box.repo, 'verify', String(item), 'accept', '--as', 'coordinator', '--note', 'private real affected-test fixture');
    assert.equal(verified.code, 0, verified.out + verified.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  if (stableBadges) assert.equal(box.run(box.repo, 'badge').code, 0, 'committed badges already match the verified roster');
  // A later accepted-trunk importer passes on main but fails only when this already-verified item is merged.
  const addedTest = e2e.commitFile(box, box.repo, 'web/new-importer.test.js', valueTest(1), 'test(web): retain the original importing contract [G1]');
  assert.equal(addedTest.status, 0, addedTest.stderr);
  const main = box.git(box.repo, 'rev-parse', 'main');
  const mainGate = box.run(box.repo, 'gate');
  assert.equal(mainGate.code, 0, mainGate.out + mainGate.err);
  assert.match(readFileSync(join(box.repo, '.git/pullboard-gate.log'), 'utf8'), inline ? /# tests 1\b/u : /# tests 3\b/u,
    'main really executes its configured gate');
  if (inline) {
    const importer = runFixtureChild(process.execPath, ['--test', '--test-reporter=tap', 'web/new-importer.test.js'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
    assert.equal(importer.status, 0, importer.context);
    assert.match(importer.stdout, /# tests 1\b/u, 'the omitted importer really passes on main');
  }
  if (waive) assert.equal(box.run(box.repo, 'land', '--waive', 'web/new-importer.test.js', '--until', '2099-01-01', '--reason', 'private exact affected-stage waiver').code, 0);
  const outcome = box.run(box.repo, 'land', '--json');
  assert.equal(outcome.code, 0, outcome.out + outcome.err);
  const landing = JSON.parse(outcome.out);
  t.diagnostic(JSON.stringify({ landing, messages: outcome.err }));
  if (waive && !opaque) {
    assert.deepEqual(landing.landed, [item], 'an exact live waiver covers only the accounted affected failure');
    assert.equal(landing.batch.state, 'landed');
    assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), main);
    assert.equal(json(box, box.repo, 'show', String(item)).item_merged_commit, landing.batch.tip);
    assert.equal(landing.batch.proof.failures[0].file, 'web/new-importer.test.js');
  } else {
    assert.deepEqual(landing.landed, [], 'the merged-tree importer failure must stop adoption');
    assert.equal(landing.batch.state, 'blocked');
    assert.equal(box.git(box.repo, 'rev-parse', 'main'), main, 'red affected tests never move main');
    assert.equal(json(box, box.repo, 'show', String(item)).item_merged_commit, null);
  }
  const selection = selectAffectedTests(landing.batch.root, { base: landing.batch.base, commit: landing.batch.tip });
  assert.equal(selection.full, !stableBadges, selection.reason);
  if (stableBadges) assert.deepEqual(selection.files, ['web/new-importer.test.js', 'web/value.test.js']);
}

test('a batch that breaks an affected test is caught at landing [C7,V4]', t => {
  affectedBatch(t);
});

test('a finite affected import subset is checked with the fixed guard floor [C7,V4]', t => {
  affectedBatch(t, { stableBadges: true });
});

test('a custom inline gate cannot omit a batch affected importer [C7,V4]', t => {
  affectedBatch(t, { stableBadges: true, inline: true });
});


test('a generated affected phase retains exact person waiver accounting [C7,V4]', t => {
  affectedBatch(t, { stableBadges: true, inline: true, waive: true });
});

test('an opaque inline gate remains unaccounted despite an affected waiver [C7,V4]', t => {
  affectedBatch(t, { stableBadges: true, inline: true, waive: true, opaque: true });
});
