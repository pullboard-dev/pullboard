/** The runner recomputes the submit composition from main and head and refuses COMPOSITION_MISMATCH before any proof runs [C7,U159]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { temporaryRepository } from '../../../../../packages/store/tests/fixtures/submit.js';
import { runHandoffStages } from '../../../src/io/handoff.js';

const quiet = async () => {};

/** A real repository where an item head and a moved main edit different files, so Git composes them cleanly. */
function repo(t, conflict = false) {
  const root = temporaryRepository(t, 'pb-handoff-compose-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
  const commit = (file, text, message) => {
    writeFileSync(join(root, file), text);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('checkout', '-q', '-b', 'item');
  const head = commit(conflict ? 'c.txt' : 'b.txt', 'item\n', 'item');
  git('checkout', '-q', 'main');
  const main = commit('c.txt', 'main\n', 'main moved');
  // A conflicting pair has no clean composition, so the fixture carries no tree for it.
  const tree = conflict ? '' : git('merge-tree', '--write-tree', main, head).split('\n')[0];
  return { root, head, main, tree };
}

/** Run the hand-off on the repository with `extra` ticket fields; the criterion and proof stages record that they ran. */
async function handoff(t, extra, composition = { requireSubmitComposition() {} }, conflict = false) {
  const { root, head, main, tree } = repo(t, conflict);
  writeFileSync(join(root, '.pullboard-handoff.log'), '');
  const ran = [];
  const stages = { authorization: quiet, doctrine: quiet, cells: quiet, criterion: async () => { ran.push('criterion'); }, proof: async () => { ran.push('proof'); } };
  const input = { job: 'j1', commit: head, main, trunk: main, ...extra({ head, main, tree }) };
  const result = await runHandoffStages(root, input, { logFile: join(root, '.pullboard-handoff.log'), services: { composition }, stages });
  return { result, ran, head, main, tree };
}

test('runner.handoff-composition.tree-mismatch: clause 1: a composition triple whose tree differs from the runner\'s own merge-tree of main and head is refused COMPOSITION_MISMATCH naming both tree ids before any proof stage [C7,U159]', async t => {
  const wrong = 'e'.repeat(40);
  const { result, ran, tree } = await handoff(t, ({ head, main }) => ({ compositionTriple: { main, head, tree: wrong } }));
  assert.equal(result.green, false);
  assert.equal(result.failed.stage, 'composition');
  assert.equal(result.failed.code, 'COMPOSITION_MISMATCH');
  assert.ok(result.failed.message.includes(wrong), 'the refusal names the submitted tree');
  assert.ok(result.failed.message.includes(tree), 'and the tree the runner composed');
  assert.deepEqual(ran, [], 'no criterion or proof stage ran');
});

test('runner.handoff-composition.tree-equal: clause 2: an equal composition tree passes the stage and the proof stage runs on that composition [C7,U159]', async t => {
  const calls = [];
  const { result, ran } = await handoff(t, ({ head, main, tree }) => ({ composition: head, compositionTriple: { main, head, tree } }), { requireSubmitComposition: (...args) => calls.push(args) });
  assert.equal(result.green, true);
  assert.deepEqual(result.stages.map(stage => `${stage.name}:${stage.state}`), ['authorization:ok', 'doctrine:ok', 'cells:ok', 'composition:ok', 'criterion:ok', 'proof:ok']);
  assert.deepEqual(ran, ['criterion', 'proof']);
  assert.deepEqual(calls, [], 'the recomputed tree replaces the object-reading rule, which needs the composition commit');
});

test('runner.handoff-composition.no-triple: clause 3: an input without the triple runs today\'s composition stage unchanged [C7,U159]', async t => {
  const calls = [];
  const { result, ran, head, main } = await handoff(t, ({ head }) => ({ composition: head, base: 'parent1' }), { requireSubmitComposition: (...args) => calls.push(args) });
  assert.equal(result.green, true);
  assert.deepEqual(calls.map(([, ...rest]) => rest), [[head, { commit: main }, main, 'parent1']], 'the rule gets the candidate, trunk, main and parent base as before');
  assert.deepEqual(ran, ['criterion', 'proof']);
});

test('runner.handoff-composition.no-tree-composed: clause 1: a composition triple with main and head but no tree is composed by the runner and the proof stage runs [C7,#11009]', async t => {
  const { result, ran } = await handoff(t, ({ head, main }) => ({ compositionTriple: { main, head } }));
  assert.equal(result.green, true);
  assert.deepEqual(ran, ['criterion', 'proof']);
});

test('runner.handoff-composition.no-tree-conflict: clause 2: a main and head that conflict are refused COMPOSITION_MISMATCH when no tree is sent, before any proof stage [C7,#11009]', async t => {
  const { result, ran } = await handoff(t, ({ head, main }) => ({ compositionTriple: { main, head } }), undefined, true);
  assert.equal(result.green, false);
  assert.equal(result.failed.stage, 'composition');
  assert.equal(result.failed.code, 'COMPOSITION_MISMATCH');
  assert.deepEqual(ran, []);
});
