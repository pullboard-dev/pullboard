/** landing.reofferTrunkBusy: a land job retried on a new trunk tip skips the static checks while trunk's new commits miss the batch's files [C7,#9103]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticCarry } from '../../src/io/runner/static-carry.js';
import { fixture } from '../fixtures/plan.js';
import { git } from '../fixtures/plan.js';

/**
 * A real repository with item 7 on its own branch (it changes web/item.txt) and a trunk that can move: `land(base)`
 * checks out base and merges the item, as each push attempt does; `move(file)` commits one file on trunk and returns the tip.
 */
function repository(t) {
  const { root, put } = fixture(t);
  put('web/item.txt', 'base\n');
  put('web/other.txt', 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  git(root, 'branch', '-q', '-M', 'trunk');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', '-b', 'item-7', base);
  put('web/item.txt', 'item 7\n');
  git(root, 'commit', '-q', '-am', 'feat: item 7');
  const land = tip => { git(root, 'checkout', '-q', '--detach', tip); git(root, 'merge', '-q', '--no-ff', '-m', 'Merge #7', 'item-7'); };
  const move = (file, text) => {
    git(root, 'checkout', '-q', 'trunk');
    put(file, text);
    git(root, 'commit', '-q', '-am', `chore: trunk moves ${file}`);
    return git(root, 'rev-parse', 'HEAD').trim();
  };
  return { root, base, land, move };
}

/** A static check that counts its runs and is always green. */
function counted() {
  const runs = [];
  return { runs, run: context => { runs.push(context.base); return { ok: true, detail: null }; } };
}

test('clause 1: with landing.reofferTrunkBusy on, a retry on a tip whose new commits touch none of the item\'s files skips the static checks [C7,#9103]', async t => {
  const { root, base, land, move } = repository(t);
  const carry = staticCarry({ enabled: true });
  const check = counted();
  land(base);
  assert.equal((await carry({ root, base, items: [7] }, check.run)).ok, true);
  const tip = move('web/other.txt', 'trunk moved\n');
  land(tip);
  const second = await carry({ root, base: tip, items: [7] }, check.run);
  assert.deepEqual(check.runs, [base], 'the static checks ran on the first attempt only');
  assert.equal(second.ok, true);
  assert.equal(second.carried, true, 'the earlier green is carried to the new tip');
  const later = move('web/other.txt', 'trunk moved again\n');
  land(later);
  assert.equal((await carry({ root, base: later, items: [7] }, check.run)).carried, true, 'and to each later disjoint tip');
  assert.deepEqual(check.runs, [base]);
});

test('clause 2: the static checks run again when trunk\'s new commits touch an item\'s file, and every attempt with landing.reofferTrunkBusy off [C7,#9103]', async t => {
  const { root, base, land, move } = repository(t);
  const carry = staticCarry({ enabled: true });
  const check = counted();
  land(base);
  await carry({ root, base, items: [7] }, check.run);
  const overlap = move('web/item.txt', 'trunk touched the item file\n');
  // The item no longer merges cleanly on this tip, so check the trunk tip itself: what matters is that the commits overlap.
  git(root, 'checkout', '-q', '--detach', overlap);
  const again = await carry({ root, base: overlap, items: [7] }, check.run);
  assert.deepEqual(check.runs, [base, overlap], 'a commit touching web/item.txt runs the static checks again');
  assert.equal(again.carried, undefined);
  const other = repository(t);
  const off = staticCarry();
  const plain = counted();
  other.land(other.base);
  await off({ root: other.root, base: other.base, items: [7] }, plain.run);
  const tip = other.move('web/other.txt', 'trunk moved\n');
  other.land(tip);
  const result = await off({ root: other.root, base: tip, items: [7] }, plain.run);
  assert.deepEqual(plain.runs, [other.base, tip], 'off (the default), the static checks run on every attempt, as on main');
  assert.equal(result.carried, undefined);
});
