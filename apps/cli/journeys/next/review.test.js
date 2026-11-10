/** next hands a builder build work when the only review it would offer is one its own family built [N2,V1]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureOpenBoard } from '../../tests/fixtures/testkit.js';
import * as store from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { HOUR } from '../../tests/fixtures/next/order.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';

/** The model name both Haiku seats join with; the fixture only needs a valid one. */
const SEAT_MODEL = 'Fixture model';

/** The verify policy an item froze on a board with verify.family require and a one-review relaxation threshold. */
const RELAXED_FREEZE = () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 1 } } }), digest: 'relaxed-family-digest' });

/**
 * Record the fixture's submission, preparing it again when another connection committed in between.
 * Why: the seats' background board writes land between the submit's preparation and its write on a loaded runner,
 * and BOARD_BUSY says exactly to retry from the current snapshot; the recorded red run (flake evidence 06a2dd0e) failed with exactly this BOARD_BUSY in submitFixture [N2,V1].
 */
function submitSettled(board, id, options) {
  for (let attempt = 1; ; attempt += 1) {
    try { return submitFixture(board, id, options); }
    catch (error) { if (error?.code !== 'BOARD_BUSY' || attempt >= 5) throw error; }
  }
}

/**
 * A board whose review ratio is reached by one submission built by a Haiku seat, with one buildable item waiting.
 * The frozen relaxation threshold of 1 makes the same-family review offerable, as on a busy board with familyRelaxAt.
 */
function familyReviewBoard(t) {
  const box = crossLaneFixture(t);
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config,
    verify: { ...config.verify, family: 'require', reviewRatio: 1, familyRelaxAt: 1 } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: require a different review family');
  const joinFamily = (name, family) => {
    const root = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    const seat = box.json(box.runAs(`${name}-session`, root, 'join', 'web', '--family', family, '--model', SEAT_MODEL, '--route', 'strong', '--json'));
    return { ...seat, root, session: `${name}-session` };
  };
  const author = joinFamily('haiku-author', 'Haiku');
  const builder = joinFamily('haiku-builder', 'Haiku');
  const review = box.add('web', 'A review only the Haiku family waits on');
  const build = box.add('web', 'Buildable work for the Haiku seat');
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try {
    store.claim(board, review, { agentId: author.agent, lane: 'web', leaseMs: HOUR, freeze: RELAXED_FREEZE });
    submitSettled(board, review, { agentId: author.agent, commit, tree });
  } finally { store.closeBoard(board); }
  return { box, joinFamily, builder, review, build };
}

test('clause 1: with the review ratio reached and every awaiting review built by its own family, next claims build work [N2,V1]', t => {
  const { box, builder, review, build } = familyReviewBoard(t);
  const result = box.runAs(builder.session, builder.root, 'next', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  const next = JSON.parse(result.out);
  assert.equal(next.review, false, `the same-family review is not offered: ${result.out}`);
  assert.equal(next.item.item_id, build, 'next claims the buildable item as if no review were waiting');
  assert.notEqual(next.item.item_id, review);
  assert.equal(next.offer, undefined, 'no review offer stands in front of the build');
});

test('clause 2: a seat whose family can review still gets the review first [N2,V1]', t => {
  const { box, joinFamily, review } = familyReviewBoard(t);
  const reviewer = joinFamily('openai-builder', 'OpenAI');
  const result = box.runAs(reviewer.session, reviewer.root, 'next', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  const next = JSON.parse(result.out);
  assert.equal(next.item.item_id, review, `the other-family seat is offered the review first: ${result.out}`);
});
