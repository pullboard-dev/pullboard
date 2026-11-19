/** The cells snapshot harness builds a main and a candidate repository that differ only by the edit [C7,#10939]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { cellsSnapshotProblems } from '../../src/io/cells-submit-checks.js';
import { cellsSnapshotPair } from '../fixtures/cells/snapshot.js';

const git = (root, ...args) => runFixtureGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const files = root => git(root, 'ls-files').split('\n').sort();

test('cli.io-cells-submit-checks.the-snapshot-pair-differs-only-by-the: clause 1: the snapshot pair differs only by the edit it is given, and an unchanged candidate is identical to main [C7,#10939]', (t) => {
  const same = cellsSnapshotPair(t);
  assert.deepEqual(files(same.main.root), ['packages/codemap/data/plan/01-demo.json', 'packages/codemap/data/plan/cells.json', 'packages/demo/index.js']);
  assert.deepEqual(files(same.candidate.root), files(same.main.root));
  assert.equal(git(same.candidate.root, 'rev-parse', 'HEAD^{tree}'), git(same.main.root, 'rev-parse', 'HEAD^{tree}'), 'an unchanged candidate holds main\'s tree');
  const edited = cellsSnapshotPair(t, put => put('packages/demo/index.js', "export const demo = 'edited';\n"));
  assert.deepEqual(files(edited.candidate.root), files(edited.main.root));
  for (const file of files(edited.main.root)) {
    const same = git(edited.main.root, 'show', `HEAD:${file}`) === git(edited.candidate.root, 'show', `HEAD:${file}`);
    assert.equal(same, file !== 'packages/demo/index.js', `${file} differs only when it is the edited file`);
  }
  assert.equal(git(edited.main.root, 'show', 'HEAD:packages/demo/index.js'), "export const demo = 'demo';");
});

test('cli.io-cells-submit-checks.missing-census-cache-services-refuse-cells-submit: clause 1: cellsSnapshotProblems on an unchanged snapshot pair, given the options the submit gate builds minus withImportParseCache, refuses CELLS_SUBMIT with canonical census cache services are required [C7,#10963]', (t) => {
  const pair = cellsSnapshotPair(t);
  const options = {
    withMainCheckout: () => { throw new Error('the cache refusal comes before any main checkout'); }, acceptedArtifact: null, acceptedArtifacts: null,
    parsers: { importsIn: () => [], commonJsIn: () => [] }, cacheEligible: () => true, collectMachinery: false,
    readCutItems: () => [], onInventory: () => {}, onAllCells: () => {},
  };
  assert.throws(() => cellsSnapshotProblems(pair.main.root, pair.candidate.root, options),
    error => error.code === 'CELLS_SUBMIT' && /canonical census cache services are required/u.test(error.message));
  assert.throws(() => cellsSnapshotProblems(pair.main.root, pair.candidate.root, { ...options, withImportParseCache: work => work(), cacheEligible: undefined }),
    error => error.code === 'CELLS_SUBMIT' && /canonical census cache services are required/u.test(error.message), 'a missing cacheEligible refuses the same way');
});
