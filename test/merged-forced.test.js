/** pullboard merged --forced records hand-landed work as landed, marked forced, through the real CLI [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { BIN, machine, project } from './cockpit/fixture.js';
import { fileFixtureItem } from './testkit-fixture.js';

/** A real project with open item 1 and main's tip as the hand landing. */
function handLanded() {
  const box = machine(), alpha = project(box, 'merged-forced');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'A hand-landed fixture item', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
    run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: alpha.repo, env: box.env, encoding: 'utf8' });
  /** The board's own reads of item 1, through the CLI. */
  const readItem = () => JSON.parse(run('show', '1', '--json').stdout).item;
  const stages = () => JSON.parse(run('status', '--json').stdout);
  const merges = () => run('log', '--json').stdout.split('\n').filter(line => line.includes('"merged"')).map(line => JSON.parse(line));
  return { box, alpha, head, run, readItem, stages, merges };
}

test('clause 1: merged --forced records an unverified item as landed, forced with its reason, and the board counts it [C7]', t => {
  const { head, run, readItem, stages, merges } = handLanded();
  const plain = run('merged', '1', head);
  assert.notEqual(plain.status, 0, 'without --forced an unverified item is still refused');
  assert.match(plain.stdout + plain.stderr, /NOT_VERIFIED/u);
  const blank = run('merged', '1', head, '--forced', ' ');
  assert.notEqual(blank.status, 0);
  assert.match(blank.stdout + blank.stderr, /FORCED_REASON/u);
  assert.deepEqual(merges(), []);
  const forced = run('merged', '1', head, '--forced', 'landed by hand around the gate');
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(merges().length, 1);
  assert.equal(merges()[0].commit, head);
  assert.equal(merges()[0].forced, true);
  assert.equal(merges()[0].reason, 'landed by hand around the gate');
  const forcedItem = readItem();
  assert.equal(forcedItem.item_status, 'verified');
  assert.equal(forcedItem.item_merged_commit, head);
  assert.equal(stages().landed, 1, 'the board counts it as landed');
});

test('clause 2: an item withdrawn as met is re-recorded as forced-merged at its Merge commit [C7]', t => {
  const { head, run, readItem, stages, merges } = handLanded();
  const withdrawn = run('withdraw', '1', `met by Merge #1 onto main ${head}`);
  assert.equal(withdrawn.status, 0, withdrawn.stdout + withdrawn.stderr);
  assert.equal(readItem().item_status, 'withdrawn');
  assert.equal(stages().landed, 0);
  const forced = run('merged', '1', head, '--forced', 'hand landed, withdrawn as met');
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(merges().at(-1).from, 'withdrawn');
  assert.equal(readItem().item_status, 'verified');
  assert.equal(stages().landed, 1);
  assert.equal(stages().withdrawn, 0);
});

test('clause 3: a forced merge of a commit that is not on main is refused [C7]', t => {
  const { box, alpha, run, readItem, merges } = handLanded();
  box.git(alpha.repo, 'switch', '-q', '-c', 'side');
  box.git(alpha.repo, 'commit', '-q', '--allow-empty', '-m', 'chore(fixture): side work');
  const side = box.git(alpha.repo, 'rev-parse', 'HEAD');
  box.git(alpha.repo, 'switch', '-q', 'main');
  const refused = run('merged', '1', side, '--forced', 'not on main');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /NOT_MERGED/u);
  assert.deepEqual(merges(), []);
  assert.notEqual(readItem().item_status, 'verified');
});
