/** The cells snapshot harness builds a main and a candidate repository that differ only by the edit [C7,#10939]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { cellsSnapshotProblems } from '../../src/io/cells-submit-checks.js';
import { policyProblems } from '../../src/io/cells-submit-checks.js';
import { cellsSnapshotPair } from '../fixtures/cells/snapshot.js';
import { commonJsIn } from '../../../../packages/gate/heavy.js';
import { foreignNodeOptions } from '../../../../packages/gate/heavy.js';
import { importsIn } from '../../../../packages/gate/heavy.js';
import { withImportParseCache } from '../../../../packages/gate/heavy.js';

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

test('cli.io-cells-submit-checks.an-unchanged-candidate-returns-no-problems: clause 1: cellsSnapshotProblems on an unchanged snapshot pair, given the parsers, withImportParseCache and cacheEligible services apps/cli/src/io/submit/gate.js passes it, returns no problems [C7,#10962]', (t) => {
  const pair = cellsSnapshotPair(t);
  // The same gate front-door services the submit gate hands requireSubmitCells, not stubs.
  const options = {
    acceptedMain: pair.main.commit, withMainCheckout: () => { throw new Error('an unchanged candidate needs no main checkout'); }, acceptedArtifact: null, acceptedArtifacts: null,
    parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), collectMachinery: false,
    readCutItems: () => [], onInventory: () => {}, onAllCells: () => {},
  };
  assert.deepEqual(cellsSnapshotProblems(pair.main.root, pair.candidate.root, options).problems, []);
});

test('cli.io-cells-submit-checks.a-new-source-file-without-a-plan-row-raises-no-placement-finding: clause 1: cellsSnapshotProblems on a candidate that adds a source file with no plan row returns no placement problem, machinery row or warning [C7,#10700]', (t) => {
  const pair = cellsSnapshotPair(t, put => put('packages/demo/extra.js', "export const extra = 'no plan row';\n"));
  assert.ok(!git(pair.main.root, 'ls-files').includes('packages/demo/extra.js'), 'main holds no such file');
  assert.ok(git(pair.candidate.root, 'ls-files').includes('packages/demo/extra.js'), 'the candidate adds the unplanned file');
  const options = {
    acceptedMain: pair.main.commit, withMainCheckout: work => work(pair.main.root), acceptedArtifact: null, acceptedArtifacts: null,
    parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), collectMachinery: true,
    readCutItems: () => [], onInventory: () => {}, onAllCells: () => {},
    files: ['packages/demo/extra.js'], title: 'Move the demo cell', criterion: 'Move packages/demo/index.js to packages/demo/src/index.js and rename the cell.',
  };
  const result = cellsSnapshotProblems(pair.main.root, pair.candidate.root, options);
  const placement = text => /placement|CELLS_PLAN_UNPLACED|no cells-plan entry|stale /u.test(text);
  assert.deepEqual(result.problems.filter(placement), [], 'no placement or stale-row problem');
  assert.deepEqual((result.machinery ?? []).filter(row => row.kind === 'placement' || row.code === 'CELLS_PLAN_UNPLACED'), [], 'no placement machinery row');
  assert.deepEqual(result.warnings.filter(row => placement(JSON.stringify(row))), [], 'no placement warning');
});

test('cli.io-cells-submit-checks.a-path-mapped-into-a-cell-folder-raises-no-moved-problem: clause 1: cellsSnapshotProblems on a candidate whose path map moves a file into a cell folder returns no --moved problem [C7,#10705]', (t) => {
  const pair = cellsSnapshotPair(t, (put) => {
    put('packages/demo/moved.js', "export const moved = 'moved into the cell folder';\n");
    put('packages/codemap/data/plan/path-map/demo.json', JSON.stringify({ 'src/old-demo.js': 'packages/demo/moved.js' }, null, 2) + '\n');
  });
  assert.ok(git(pair.candidate.root, 'ls-files').includes('packages/codemap/data/plan/path-map/demo.json'), 'the candidate maps a path into the cell folder');
  const options = {
    acceptedMain: pair.main.commit, withMainCheckout: work => work(pair.main.root), acceptedArtifact: null, acceptedArtifacts: null,
    parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), collectMachinery: true,
    readCutItems: () => [], onInventory: () => {}, onAllCells: () => {},
    files: ['packages/demo/moved.js', 'packages/codemap/data/plan/path-map/demo.json'], title: 'Move a file into the demo cell', criterion: 'Move src/old-demo.js to packages/demo/moved.js.',
  };
  const result = cellsSnapshotProblems(pair.main.root, pair.candidate.root, options);
  assert.deepEqual(result.problems.filter(problem => problem.includes('--moved')), [], 'no --moved problem');
  assert.deepEqual(result.warnings.filter(row => JSON.stringify(row).includes('--moved')), [], 'no --moved warning');
});

const submitOptions = (pair, extra) => ({
  acceptedMain: pair.main.commit, withMainCheckout: work => work(pair.main.root), acceptedArtifact: null, acceptedArtifacts: null,
  parsers: { importsIn, commonJsIn }, withImportParseCache, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), collectMachinery: false,
  readCutItems: () => [], onInventory: () => {}, onAllCells: () => {}, ...extra,
});

test('cli.io-cells-submit-checks.plan-identity-edits-raise-no-problem-but-a-vanished-path-map-row-does: clause 1: policyProblems takes only the two path maps and the candidate root, a cell order, root and front door change in a plan shard raises no problem, and a disappeared accepted path-map row still does [C7,#10717]', (t) => {
  assert.equal(policyProblems.length, 3, 'two path maps and the candidate root');
  const pair = cellsSnapshotPair(t, (put) => {
    put('packages/codemap/data/plan/01-demo.json', JSON.stringify({ order: 9, name: 'demo', kind: 'package', root: 'packages/elsewhere', frontDoor: 'packages/elsewhere/main.js', paths: [], reexports: [], imports: [], cuts: [] }) + '\n');
  });
  const options = submitOptions(pair, { files: ['packages/codemap/data/plan/01-demo.json'], title: 'Edit a plan shard', criterion: 'Edit the demo plan shard.' });
  const problems = cellsSnapshotProblems(pair.main.root, pair.candidate.root, options).problems;
  assert.deepEqual(problems.filter(problem => /order|root|front door|identity/u.test(problem)), [], 'no plan identity problem');
  assert.deepEqual(policyProblems(new Map([['src/old.js', 'packages/demo/new.js']]), new Map([['src/old.js', 'packages/demo/new.js']]), pair.candidate.root), []);
  assert.deepEqual(policyProblems(new Map([['src/old.js', 'packages/demo/new.js']]), new Map(), pair.candidate.root),
    ['accepted path map disappeared: src/old.js -> packages/demo/new.js']);
});

test('cli.io-cells-submit-checks.a-new-import-through-a-shim-is-still-refused-from-path-map-rows: clause 3: shimImportProblems still refuses a new binding through a shim, fed rows built from the path maps, and accepts the same import from the front-door side [C7,#10717]', (t) => {
  const shimmed = (importer) => cellsSnapshotPair(t, (put) => {
    put('packages/demo/moved.js', "export const moved = 'moved';\n");
    put('packages/legacy/old.js', "export * from '../demo/moved.js';\n");
    put('packages/codemap/data/plan/path-map/demo.json', JSON.stringify({ 'packages/legacy/old.js': 'packages/demo/moved.js' }, null, 2) + '\n');
    put('packages/demo/user.js', `import { moved } from '${importer}';\nexport const user = moved;\n`);
  });
  const run = pair => cellsSnapshotProblems(pair.main.root, pair.candidate.root, submitOptions(pair, {
    files: ['packages/demo/moved.js', 'packages/legacy/old.js', 'packages/codemap/data/plan/path-map/demo.json', 'packages/demo/user.js'],
    title: 'Use the demo cell', criterion: 'Use the moved demo module.' })).problems.filter(problem => problem.includes('compatibility shim'));
  assert.deepEqual(run(shimmed('../legacy/old.js')), ['packages/demo/user.js:1: added import through compatibility shim packages/legacy/old.js; import from packages/demo/index.js instead']);
  assert.deepEqual(run(shimmed('./moved.js')), [], 'an import of the moved module itself is not through a shim');
});
