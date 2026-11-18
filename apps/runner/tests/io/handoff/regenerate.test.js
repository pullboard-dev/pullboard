/** With submit.composeOnRunner and submit.regenerateDeclared on, the runner regenerates stale declared generated files on the composed tree before proving it [C7,#11111]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { regenerateDeclaredFiles } from '../../../../../packages/gate/index.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { temporaryRepository } from '../../../../../packages/store/tests/fixtures/submit.js';
import { runHandoffStages } from '../../../src/io/handoff.js';

const quiet = async () => {};
const GENERATED = [{ file: 'gen/out.txt', generator: 'cp gen/in.txt gen/out.txt', inputs: ['gen/in.txt'] }];

/** A real repository where the item head edits a generator input without regenerating its output, and main moves another file, so the clean composition holds a stale generated file. */
function repo(t) {
  const root = temporaryRepository(t, 'pb-handoff-regenerate-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text);
      git('add', file);
    }
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  commit({ 'gen/in.txt': 'one\n', 'gen/out.txt': 'one\n' }, 'generated pair');
  git('checkout', '-q', '-b', 'item');
  const head = commit({ 'gen/in.txt': 'two\n' }, 'item edits the input only');
  git('checkout', '-q', 'main');
  const main = commit({ 'other.txt': 'main\n' }, 'main moved');
  const composed = git('merge-tree', '--write-tree', main, head).split('\n')[0];
  git('checkout', '-q', '--detach', head);
  return { root, head, main, composed };
}

/** Run the hand-off with the triple and `extra` ticket fields; the proof stage records the generated file it sees and the tree it runs on. */
async function handoff(t, extra, regenerate = { regenerateDeclaredFiles }) {
  const { root, head, main, composed } = repo(t);
  writeFileSync(join(root, '.pullboard-handoff.log'), '');
  const proved = {};
  const proof = async () => {
    proved.out = readFileSync(join(root, 'gen/out.txt'), 'utf8');
    proved.tree = runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: root }).trim();
  };
  const stages = { authorization: quiet, doctrine: quiet, cells: quiet, criterion: quiet, proof };
  const input = { job: 'j1', commit: head, main, trunk: main, compositionTriple: { main, head }, ...extra };
  const result = await runHandoffStages(root, input, { logFile: join(root, '.pullboard-handoff.log'), services: { composition: { requireSubmitComposition() {} }, ...(regenerate ? { regenerate } : {}) }, stages });
  return { result, proved, composed };
}

test('runner.handoff-regenerate.stale-file-regenerated: clause 1: with the setting on, a composed tree with a stale declared generated file is proved as the regenerated tree and the result names that tree [C7,#11111]', async t => {
  const { result, proved, composed } = await handoff(t, { regenerateDeclared: true, generated: GENERATED });
  assert.equal(result.green, true);
  assert.equal(proved.out, 'two\n', 'the proof stage sees the regenerated file');
  assert.notEqual(proved.tree, composed, 'the proved tree is not the stale composition');
  assert.equal(result.tree, proved.tree, 'the gate result names the regenerated tree');
});

test('runner.handoff-regenerate.generator-failure-red: clause 1: a generator that fails is a GENERATED_STALE red naming the generator message, before any proof stage [C7,#11111]', async t => {
  const { result, proved } = await handoff(t, { regenerateDeclared: true, generated: [{ ...GENERATED[0], generator: 'echo generator-broke >&2; false' }] });
  assert.equal(result.green, false);
  assert.equal(result.failed.stage, 'composition');
  assert.equal(result.failed.code, 'GENERATED_STALE');
  assert.ok(result.failed.message.includes('gen/out.txt'), `the red names the generated file: ${result.failed.message}`);
  assert.deepEqual(proved, {}, 'no proof stage ran');
});

test('runner.handoff-regenerate.setting-off-unchanged: clause 2: with the setting off the runner proves the composed tree unchanged, stale file and all [C7,#11111]', async t => {
  const { result, proved } = await handoff(t, { regenerateDeclared: false, generated: GENERATED });
  assert.equal(result.green, true);
  assert.equal(proved.out, 'one\n', 'the stale file is left as composed');
  assert.equal(result.tree, undefined, 'no regenerated tree is named');
});

test('runner.handoff-regenerate.no-regenerate-service-unchanged: clause 2: with regenerateDeclared on but no composition triple the runner regenerates nothing [C7,#11111]', async t => {
  const calls = [];
  const { result, proved } = await handoff(t, { regenerateDeclared: true, generated: GENERATED, compositionTriple: undefined, composition: 'x' }, { regenerateDeclaredFiles: (...args) => calls.push(args) });
  assert.equal(result.green, true);
  assert.deepEqual(calls, []);
  assert.equal(proved.out, 'one\n');
});
