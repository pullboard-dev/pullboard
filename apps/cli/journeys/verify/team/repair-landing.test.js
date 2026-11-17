/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
import {
  assert,
  exportBoard,
  helpers,
  importBoard,
  run,
  store,
  test,
  withBoard,
} from '../../../tests/fixtures/scenarios/team.js';
import { join } from 'node:path';
import { settleLand } from '../../../tests/fixtures/land/settle.js';

/** Run one CLI call the way the journey does (in-process, or a real process under PULLBOARD_JOURNEY_MODE=process) and return its output. */
async function go(box, root, ...args) {
  const result = await box.runIn(root, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return result.out;
}

test('clause 2: landing retains the exact repair that passed stale re-review [E8,V8,R3]', async () => {
  const box = helpers.project();
  const source = (feature, expected) => `feature = ${feature}\n${'// independent caller line\n'.repeat(12)}expected = ${expected}\n`;
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 1), 'feat(web): baseline caller [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const check = `test "$(sed -n 's/^feature = //p' web/feature.txt)" = "$(sed -n 's/^expected = //p' web/feature.txt)"`;
  run(box, box.repo, 'add', 'web', 'Repair follows its review', '--specs', 'G1', '--check', check, '--brief', 'Files: web/feature.js\nTest: the frozen check', '--criterion', 'The feature matches the caller.', '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', source(1, 1), 'feat(web): original feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  await go(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'repair-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web');
  await go(box, reviewer, 'verify', '1', 'accept', '--note', 'The original feature matches the original caller.');
  const original = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', source(0, 2).replace('feature = 0\n', 'feature = 0\n// the caller reads this beside the feature\n'), 'feat(web): caller now requires two [G1]').status, 0);
  // Main inserts directly beside the line the item changed: the patch no longer merges cleanly, so the accept is stale [#2896].
  assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state?.code, 'STALE_VERDICT');
  box.git(reviewer, 'merge', '-q', '--no-edit', '-X', 'theirs', 'main');
  assert.equal(helpers.commitFile(box, reviewer, 'web/feature.txt', source(2, 2), 'feat(web): repair against the new caller [G1]').status, 0);
  assert.equal(helpers.commitFile(box, reviewer, 'web/repair.txt', 'ready\n', 'feat(web): add the repair companion [G1]').status, 0);
  const checked = box.git(reviewer, 'rev-parse', 'HEAD');
  await go(box, reviewer, 'verify', '1', 'accept', '--note', 'The repaired composition matches the new caller; the original feature does not.');
  const reviewed = withBoard(box.repo, board => store.verdictsFor(board, 1));
  assert.deepEqual(reviewed.slice(0, original.length), original);
  assert.equal(reviewed.at(-1).verdict_head, checked);
  const probe = join(box.dir, 'repair-path-replica');
  box.git(box.dir, 'clone', '-q', box.repo, probe);
  withBoard(probe, board => importBoard(board, withBoard(box.repo, exportBoard)));
  box.git(probe, 'fetch', '-q', 'origin', `refs/pullboard/items/1/${checked.slice(0, 12)}`);
  assert.equal(helpers.commitFile(box, probe, 'web/repair.txt', 'main changed the repair\n', 'feat(web): main changes a repair file [G1]').status, 0);
  const changedRepair = JSON.parse(run(box, probe, 'show', '1', '--json'));
  assert.equal(changedRepair.item_verdict_state?.file, 'web/repair.txt', 'a file introduced by the checked repair must participate in later freshness');

  const remote = join(box.dir, 'landing-remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  // Under pull `land` offers a runner job and returns at once; settleLand waits for its receipt [C7].
  const landed = await settleLand(box, JSON.parse(await go(box, box.repo, 'land', '--json')));
  assert.deepEqual(landed.landed, [1], JSON.stringify(landed));
  assert.equal(box.git(box.repo, 'show', landed.batch.tip + ':web/feature.txt'), source(2, 2).trim(), 'landing must retain the exact repaired file that passed the frozen check');
  assert.equal(box.git(box.remote ?? remote, 'rev-parse', 'main'), landed.batch.tip);
  assert.equal(withBoard(box.repo, board => store.getItem(board, 1)).item_commit, submitted, 'the original submission remains the immutable item identity');
});
