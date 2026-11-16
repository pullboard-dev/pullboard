/** Settling a gate red from a nearby main receipt runs one Git process per red file, however large the cache [C7,#6717]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realGitAdapter } from '../../../../git/index.js';
import { withGitContractAdapter } from '../../../../git/index.js';
import { mainReceipts } from '../../../index.js';
import { nearbyMainClass } from '../../../index.js';
import { recordMainTestReceipt } from '../../../index.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { CELL_CONFIG } from '../../../../store/tests/fixtures/cell.js';

const FILE = 'web/main.test.js';

/** Run `work` and count the Git processes it starts through the adapter. */
function counted(work) {
  const calls = [];
  const adapter = {
    spawnSync(args, options) { calls.push(args); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { calls.push(args); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { calls.push(args); return realGitAdapter.spawn(args, options); },
  };
  return { value: withGitContractAdapter(adapter, work), calls };
}

/** A main of `count` commits after the gate's main, each moving an unrelated file; `changeAt` edits FILE on that step. */
function movingMain(t, count, changeAt = -1) {
  const repo = cellRepo(t, { real: true, config: { ...CELL_CONFIG, affectedTests: 'node --test' } });
  repo.put(FILE, "test('main case', () => { throw new Error('main'); });\n");
  repo.put('other.txt', '0\n');
  const gate = repo.commitAll();
  const later = [];
  for (let step = 0; step < count; step++) {
    repo.put('other.txt', `${step + 1}\n`);
    if (step === changeAt) repo.put(FILE, "test('main case', () => {});\n");
    later.push(repo.commitAll());
  }
  return { root: repo.root, gate, later };
}

/** Fill the cache with receipts on every later main plus keys that are not commits, as the board's cache held. */
function crowdCache(root, mains) {
  mains.forEach((main, index) => recordMainTestReceipt(root, { main, file: FILE, verdict: 'red', job: `job-${index}` }));
  for (let index = 0; index < 60; index++) {
    recordMainTestReceipt(root, { main: index.toString(16).padStart(2, '0').repeat(20), file: FILE, verdict: 'red', job: `junk-${index}` });
  }
}

test('clause 1: a file unchanged on later mains answers from the nearest receipt with one Git process for 100 cached keys [C7,#6717]', { timeout: 60_000 }, // budget: one fixture repo with 40 commits, no runner.
t => {
  const { root, gate, later } = movingMain(t, 40);
  crowdCache(root, later);
  assert.ok(mainReceipts(root, gate, [FILE]), 'the caller reads the gate main\'s receipts first, as criterionMainReceipts does');
  const { value, calls } = counted(() => nearbyMainClass(root, gate, FILE, ['main case']));
  assert.equal(calls.length, 1, `one Git process, not one pair per cached key: ${JSON.stringify(calls.map(args => args.slice(0, 4)))}`);
  assert.notEqual(value?.owner ?? 'unknown', 'unknown', JSON.stringify(value));
  assert.equal(value.receipt, 'job-0', 'the nearest later main answers');
});

test('clause 1: a file changed on a later main answers only from mains before the change, still with one Git process [C7,#6717]', { timeout: 60_000 }, // budget: one fixture repo with 40 commits, no runner.
t => {
  const { root, gate, later } = movingMain(t, 40, 5);
  crowdCache(root, later.slice(5));
  mainReceipts(root, gate, [FILE]);
  const changed = counted(() => nearbyMainClass(root, gate, FILE, ['main case']));
  assert.equal(changed.calls.length, 1);
  assert.equal(changed.value, null, 'every receipt sits after the file changed, so none answers');
  recordMainTestReceipt(root, { main: later[3], file: FILE, verdict: 'red', job: 'job-before-change' });
  const before = counted(() => nearbyMainClass(root, gate, FILE, ['main case']));
  assert.equal(before.calls.length, 1);
  assert.equal(before.value?.receipt, 'job-before-change');
});
