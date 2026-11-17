/** @pullboard-test-input packages/landing/src/io/runner/contracts.js */
/** @pullboard-test-input packages/landing/src/logic/main/ledger.js */
/** A land job counts a red in a file the ledger's red-now list records red on main at its base as main's, behind landing.ledgerMainReds [C7,U152,#8556]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { landingMainReds } from '../../../index.js';
import { mainOwnedReds } from '../../../src/io/runner/contracts.js';

const ON = { landing: { ledgerMainReds: true } };
// redNow's answer over the ledger rows: one red per file and context class, with the commit its newest red row ran at.
const red = (file, at, commit, context = 'ctx') => ({ file, inputKey: `k${at}`, context, commit, at });

/** A real main with two commits holding the red files, and an item branch commit off main. */
function mainFixture(t) {
  const { root, put } = fixture(t);
  put('tests/red.test.js', 'red on main\n');
  put('tests/green.test.js', 'green on main\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main: tests');
  const earlier = git(root, 'rev-parse', 'HEAD').trim();
  put('tests/later.test.js', 'later\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main: later');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', '-b', 'item');
  put('tests/green.test.js', 'red on the item only\n');
  git(root, 'commit', '-q', '-am', 'item');
  const item = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', 'main');
  return { root, earlier, base, item };
}

test('landing.main-reds.a-land-job-whose-only-reds: clause 1: a land job whose only reds are files redNow records red on main at the base lands with those files named [C7,#8556]', async t => {
  const box = mainFixture(t);
  // red.test.js: red at an earlier main commit, still the newest row; later.test.js: red at the base itself.
  const mainReds = landingMainReds(ON, [red('tests/red.test.js', 10, box.earlier), red('tests/later.test.js', 12, box.base), red('tests/later.test.js', 5, box.earlier, 'other')]);
  assert.deepEqual(mainReds, [['tests/later.test.js', box.base], ['tests/red.test.js', box.earlier]], 'each red-now file rides once with its newest red commit, newest first');
  const failures = [{ file: 'tests/red.test.js', name: 'case a' }, { file: 'tests/later.test.js', name: 'case b' }];
  const reran = [];
  const known = await mainOwnedReds({ root: box.root, base: box.base }, failures, { mainReds, rerun: async rows => { reran.push(rows); return null; } });
  assert.deepEqual(known, { known: failures, ledger: ['tests/later.test.js', 'tests/red.test.js'] }, 'main owns both reds and the files are named');
  assert.deepEqual(reran, [], 'no case-for-case rerun on the base was needed');
});

test('landing.main-reds.a-land-job-with-a-red: clause 2: a land job with a red redNow does not record on main is held [C7,#8556]', async t => {
  const box = mainFixture(t);
  // green.test.js is red only at the item's own commit, which is not on main; red.test.js is red on main.
  const mainReds = landingMainReds(ON, [red('tests/red.test.js', 10, box.earlier), red('tests/green.test.js', 11, box.item)]);
  const failures = [{ file: 'tests/red.test.js', name: 'case a' }, { file: 'tests/green.test.js', name: 'new red' }];
  const reran = [];
  const held = await mainOwnedReds({ root: box.root, base: box.base }, failures, { mainReds, rerun: async rows => { reran.push(rows); return null; } });
  assert.equal(held, null, 'a red the base passes holds the landing');
  assert.deepEqual(reran, [[{ file: 'tests/green.test.js', name: 'new red' }]], 'only the red the ledger does not record on main is rerun on the base');
  const cleared = landingMainReds(ON, []);
  assert.deepEqual(cleared, [], 'a file redNow no longer lists rides on no job');
  assert.equal(await mainOwnedReds({ root: box.root, base: box.base }, [failures[0]], { mainReds: cleared, rerun: async () => null }), null);
});

test('landing.main-reds.with-landing-ledgermainreds-off-a-land: clause 3: with landing.ledgerMainReds off, a land job behaves as today [C7,#8556]', async t => {
  const box = mainFixture(t);
  const rows = [red('tests/red.test.js', 10, box.earlier)];
  assert.deepEqual(landingMainReds({}, rows), [], 'off by default: no ledger reds ride on the job');
  assert.deepEqual(landingMainReds({ landing: { ledgerMainReds: false } }, rows), []);
  const failures = [{ file: 'tests/red.test.js', name: 'case a' }];
  const reran = [];
  const held = await mainOwnedReds({ root: box.root, base: box.base }, failures, { mainReds: null, rerun: async rows => { reran.push(rows); return null; } });
  assert.equal(held, null, 'off, a red the base rerun does not match holds the landing');
  assert.deepEqual(reran, [failures], 'off, every red is rerun on the base as before');
  const shared = await mainOwnedReds({ root: box.root, base: box.base }, failures, { mainReds: null, rerun: async rows => rows });
  assert.deepEqual(shared, { known: failures, ledger: [] }, 'off, a red the base fails case for case is main\'s, as before');
});
