import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../apps/lib/index.js';
import * as store from '../packages/store/index.js';
import { submitFixture } from './board-submit-fixture.js';
import { HOUR, FREEZE } from './next-order-fixture.js';
import { crossLaneFixture } from './e2e-helpers.js';

test('a builder nexts past same-family reviews it cannot take [N2,B13]', t => {
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
    const seat = box.json(box.runAs(session, root, 'join', 'web', '--family', family, '--model', family, '--json'));
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
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    store.claim(board, review, { agentId: author.agent, lane: 'web', leaseMs: HOUR, freeze: FREEZE });
    submitFixture(board, review, { agentId: author.agent, commit, tree });
  } finally { store.closeBoard(board); }

  const first = box.json(box.runAs('haiku-builder-session', builder.root, 'next', '--json'));
  assert.equal(first.review, false, 'the same-family submission is not returned as a review step');
  assert.equal(first.item.item_id, build, 'next moves on to buildable work');
  assert.notEqual(first.item.item_id, review);

  const second = box.runAs('haiku-peer-session', peer.root, 'next', '--json');
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
