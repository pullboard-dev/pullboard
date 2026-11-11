/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** A verified item whose change main already carries closes as landed, never STALE_VERDICT [C7,#2980]. */
import {
  assert,
  helpers,
  run,
  store,
  test,
  withBoard,
} from '../../tests/fixtures/scenarios/team.js';
import { join } from 'node:path';

test('an accept whose change main already contains reads fresh and lands without re-review [C7,#2980]', { timeout: 120_000 }, () => { // budget: hang ceiling for real Git, CLI verify and landing; not a speed target.
  const box = helpers.project();
  box.env.PULLBOARD_MODEL = 'already-on-main-fixture';
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 0\nother = 0\n', 'feat(web): baseline [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  run(box, box.repo, 'add', 'web', 'Duplicate feature line', '--specs', 'G1', '--route', 'strong', '--criterion', 'the feature line reads 1', '--check', "grep -q '^feature = 1$' web/feature.txt", '--wait');
  run(box, box.web, 'claim', '1');
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', 'feature = 1\nother = 0\n', 'feat(web): feature [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  run(box, box.web, 'submit', '1');
  const reviewer = join(box.dir, 'already-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  run(box, reviewer, 'join', 'web', '--route', 'strong'); // the item routes strong, and a strong verifier covers every route
  run(box, reviewer, 'verify', '1', 'accept', '--note', 'The feature line flips and the frozen check observes it.');
  const verdicts = withBoard(box.repo, board => store.verdictsFor(board, 1)).length;
  // A sibling item lands the identical one-line change first, as #1938 did for #1939.
  assert.equal(helpers.commitFile(box, box.repo, 'web/feature.txt', 'feature = 1\nother = 0\n', 'feat(web): sibling lands the same change [G1]').status, 0);
  const shown = JSON.parse(run(box, box.repo, 'show', '1', '--json'));
  assert.equal(shown.item_verdict_state?.code, undefined, JSON.stringify(shown.item_verdict_state));

  const remote = join(box.dir, 'already-remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const landed = JSON.parse(run(box, box.repo, 'land', '--json'));
  assert.deepEqual(landed.landed, [1], JSON.stringify(landed));
  const item = withBoard(box.repo, board => store.getItem(board, 1));
  assert.equal(item.item_merged_commit, landed.batch.tip, 'the item is recorded landed on the main that already held its change');
  assert.equal(JSON.parse(run(box, box.repo, 'show', '1', '--json')).item_verdict_state, undefined, 'a closed landing carries no stale verdict');
  assert.equal(box.git(box.repo, 'show', 'main:web/feature.txt'), 'feature = 1\nother = 0');
  assert.equal(withBoard(box.repo, board => store.verdictsFor(board, 1)).length, verdicts, 'closing needs no second review');
});
