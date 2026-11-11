import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  HOUR,
  FREEZE,
} from '../../tests/fixtures/next/order.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

/** Enable the private board's native first-review dispatch policy. */
function reviewsFirst(box) {
  store.setLineSetting(box.board, { agentId: 'coordinator', key: 'reviewsFirst', value: true,
    reason: 'Private mandatory first-review dispatch control', window: { windowMinutes: 30 } });
}

test('clause 1: a builder nexts past same-family reviews it cannot take [N2,B13]', t => {
  const box = crossLaneFixture(t);
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config,
    verify: { ...config.verify, family: 'require', reviewRatio: 1 } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: require a different review family');

  const joinFamily = (name, session, family = 'Haiku') => {
    const root = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    const seat = box.json(box.runAs(session, root, 'join', 'web', '--family', family, '--model', family, '--route', 'strong', '--json'));
    return { ...seat, root };
  };
  const author = joinFamily('haiku-author', 'haiku-author-session');
  const builder = joinFamily('haiku-builder', 'haiku-builder-session');
  const peer = joinFamily('haiku-peer', 'haiku-peer-session');
  const reviewer = joinFamily('openai-reviewer', 'openai-reviewer-session', 'OpenAI');
  const review = box.add('web', 'A review this family cannot take');
  const build = box.add('web', 'Buildable work for the Haiku seat');
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    store.claim(board, review, { agentId: author.agent, lane: 'web', leaseMs: HOUR, freeze: FREEZE });
    submitFixture(board, review, { agentId: author.agent, commit, tree });
  } finally { store.closeBoard(board); }

  const first = box.json(box.runAs('haiku-builder-session', builder.root, 'next', '--json'));
  assert.equal(first.review, false, 'the same-family submission is not returned as a review step');
  assert.equal(first.item.item_id, build, 'next moves on to buildable work');
  assert.notEqual(first.item.item_id, review);

  const second = box.runAs('haiku-peer-session', peer.root, 'next', '--take', '--json');
  assert.notEqual(second.code, 0, 'a second ineligible seat has no work after the build claim');
  const refusal = JSON.parse(second.out).error;
  assert.equal(refusal.code, 'NOTHING_FREE');
  for (const guidance of [refusal.message, refusal.next ?? '']) {
    assert.doesNotMatch(guidance, new RegExp(`pullboard\\s+(?:show|verify)\\s+#?${review}\\b`, 'iu'),
      'the ineligible submission is never offered as an actionable review step');
    assert.doesNotMatch(guidance, new RegExp(`\\b(?:review|verify)\\s+#?${review}\\b`, 'iu'),
      'the refusal does not direct the builder to review the ineligible submission');
  }

  const eligible = box.json(box.runAs('openai-reviewer-session', reviewer.root, 'next', '--verify', '--json'));
  assert.equal(eligible.item.item_id, review, 'a different-family reviewer retains its eligible review path');
});

test('clause 2: explicit build intent skips an eligible mandatory aged review [N2,B13]', async t => {
  const box = await fixture(t);
  const review = box.add('Eligible mandatory first review');
  box.submit(review);
  const build = box.add('Explicit build work', { brief: 'Files: web/explicit-build.js\nTest: explicit build intent selects independent work.' });
  reviewsFirst(box);
  box.advance(16 * 60_000);

  const mandatory = store.reviewOffer(box.board, { agentId: box.seats.actor.id, lane: box.seats.actor.lane,
    policy: box.config.verify.policy, familyPolicy: box.config.verify.family, mandatoryOnly: true });
  assert.equal(mandatory?.item.item_id, review, 'the review is genuinely eligible and past the first-review age threshold');

  const selected = await cli(box, box.seats.actor.path, ['next', '--build']);
  assert.equal(selected.code, 0, selected.out + selected.err);
  assert.equal(selected.document.review, false);
  assert.equal(selected.document.item.item_id, build, 'clause 2: explicit build intent claims buildable work');
  assert.equal(store.getItem(box.board, review).item_review_by, null, 'the mandatory review remains unreserved');
  assert.equal(store.getItem(box.board, build).item_owner, box.seats.actor.id);
});
