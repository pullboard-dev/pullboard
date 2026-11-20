/** @pullboard-test-input source-cell packages/items */
/** Every MAIN_NOT_COMPOSED refusal says submit again, since submit composes current main, and keeps the commits and overlaps it names (U159 F3). [C7,V4] */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';
import { composeAfterProof } from '../../../../index.js';
import { requireSubmitComposition } from '../../../../index.js';

const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const AGAIN = /run pullboard submit <id> again, since submit composes current main/u;
const OLD = /merge main into this worktree|commit the composition/u;

/** A repo with initial -> main (edits shared.txt) and a side branch whose own edit of shared.txt conflicts with main. */
function history() {
  const files = privateFixtureFiles('pullboard-compose-text-');
  const root = files.root;
  const run = (...args) => runFixtureGit([...IDENT, ...args], { cwd: root }).trim();
  run('init', '-q', '-b', 'main');
  const commit = (name, body) => { files.write(name, body); run('add', '.'); run('commit', '-qm', `test: ${name} ${body}`); return run('rev-parse', 'HEAD'); };
  const initial = commit('shared.txt', 'base');
  const main = commit('shared.txt', 'main edit');
  run('checkout', '-qb', 'side', initial);
  const side = commit('shared.txt', 'side edit');
  return { root, initial, main, side };
}

const caught = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected a refusal'); };
const caughtAsync = async (fn) => { try { await fn(); } catch (error) { return error; } return assert.fail('expected a refusal'); };

test('items.composition.submit-again-text: clause 1: every MAIN_NOT_COMPOSED refusal says run pullboard submit again, not merge main [C7,V4]', async () => {
  const f = history();
  const direct = caught(() => requireSubmitComposition(f.root, f.side, { commit: f.main }, f.main));
  const notContained = await caughtAsync(() => composeAfterProof(f.root, { id: 7, proofCommit: f.side, proved: f.side, item: {}, check: null, readTrunk: () => ({ commit: f.main }) }, {}));
  const overlap = await caughtAsync(() => composeAfterProof(f.root, { id: 7, proofCommit: f.side, proved: f.initial, item: {}, check: null, readTrunk: () => ({ commit: f.main }) }, { judgeTrunkMove: async () => ({ overlaps: ['shared.txt'], moved: ['shared.txt'] }) }));
  const conflict = await caughtAsync(() => composeAfterProof(f.root, { id: 7, proofCommit: f.side, proved: f.initial, item: {}, check: null, readTrunk: () => ({ commit: f.main }) }, { judgeTrunkMove: async () => ({ overlaps: [], moved: ['shared.txt'] }) }));
  for (const error of [direct, notContained, overlap, conflict]) {
    assert.equal(error.code, 'MAIN_NOT_COMPOSED');
    assert.match(error.next ?? error.message, /run pullboard submit <id> again/u);
    assert.doesNotMatch(error.message, OLD);
  }
  for (const error of [direct, notContained, overlap]) assert.match(error.message, AGAIN);
});

test('items.composition.names-commits-overlaps: clause 2: each refusal still names the main commits and overlaps it names today [C7,V4]', async () => {
  const f = history();
  const direct = caught(() => requireSubmitComposition(f.root, f.side, { commit: f.main }, f.main));
  assert.ok(direct.message.includes(f.main.slice(0, 12)), 'the current main commit is named');
  const notContained = await caughtAsync(() => composeAfterProof(f.root, { id: 7, proofCommit: f.side, proved: f.side, item: {}, check: null, readTrunk: () => ({ commit: f.main }) }, {}));
  assert.ok(notContained.message.includes(f.side.slice(0, 12)) && notContained.message.includes(f.main.slice(0, 12)), 'both commits are named');
  const overlap = await caughtAsync(() => composeAfterProof(f.root, { id: 7, proofCommit: f.side, proved: f.initial, item: {}, check: null, readTrunk: () => ({ commit: f.main }) }, { judgeTrunkMove: async () => ({ overlaps: ['shared.txt'], moved: ['shared.txt'] }) }));
  assert.ok(overlap.message.includes(f.initial.slice(0, 12)) && overlap.message.includes(f.main.slice(0, 12)) && overlap.message.includes('shared.txt'), 'both commits and the overlap are named');
});
