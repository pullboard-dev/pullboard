/** A head carrying commits that name a withdrawn item is submittable for its replacement; a live item still refuses [V1,C7]. */
// fixture-subject: addItem (the board is seeded with items whose status the guard reads)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { refuseUnsubmittableStack } from '../../../src/io/submit.js';
import * as store from '../../../../../packages/store/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { fixtureBoard } from '../../fixtures/board.js';
import {
  runFixtureGit,
  runFixtureSetupGit,
} from '../../fixtures/child.js';
import { temporaryRepository } from '../../fixtures/board/submit.js';

/** A repository with main and one commit naming item 1, and a board holding item 1 (withdrawn when asked) and a replacement item. */
function carried(t, status) {
  const root = temporaryRepository(t, 'pullboard-wrong-branch-');
  const trunk = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  writeFileSync(join(root, 'carried.txt'), 'carried over from the first item\n');
  runFixtureGit(['add', 'carried.txt'], { cwd: root });
  runFixtureSetupGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'test: carried [G1]', '-m', 'Pullboard-Item: #1'], { cwd: root });
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const board = fixtureBoard(t);
  const add = (title) => store.addItem(board, {
    by: COORDINATOR, lane: 'web', title, criterion: 'The guard holds.',
    check: 'true', specIds: ['C7'], brief: 'Files: web/guard.js\nTest: the guard holds.',
  });
  const first = add('First item');
  const second = add('Replacement item');
  if (status === 'withdrawn') store.withdraw(board, first, { agentId: COORDINATOR, reason: 'fixture replaced by a new item' });
  return { root, board, head, trunk: { ref: 'main', commit: trunk }, replacement: { item_id: second } };
}

test('cli.io-submit-wrong-branch.withdrawn-item-carried: [C7] refuseWrongBranch passes a head whose new commits name only a withdrawn item', (t) => {
  const { root, board, head, trunk, replacement } = carried(t, 'withdrawn');
  assert.doesNotThrow(() => refuseUnsubmittableStack(root, board, replacement, head, trunk));
});

test('cli.io-submit-wrong-branch.live-item-refused: [C7] a head whose new commits name an open other item and none of this one is still refused WRONG_BRANCH', (t) => {
  const { root, board, head, trunk, replacement } = carried(t, 'open');
  assert.throws(() => refuseUnsubmittableStack(root, board, replacement, head, trunk), (error) => error.code === 'WRONG_BRANCH' && error.message.includes('#1'));
});

test('cli.io-submit-wrong-branch.stack-path: [C7] refuseUnsubmittableStack hands its board to the wrong-branch check, so a withdrawn name passes and a live one refuses', (t) => {
  const withdrawn = carried(t, 'withdrawn');
  assert.doesNotThrow(() => refuseUnsubmittableStack(withdrawn.root, withdrawn.board, withdrawn.replacement, withdrawn.head, withdrawn.trunk));
  const live = carried(t, 'open');
  assert.throws(() => refuseUnsubmittableStack(live.root, live.board, live.replacement, live.head, live.trunk), (error) => error.code === 'WRONG_BRANCH');
});
