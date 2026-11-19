/** A head carrying commits that name a withdrawn item is submittable for its replacement; a live item still refuses [V1,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { refuseUnsubmittableStack } from '../../../src/io/submit.js';
import { fixtureBoard } from '../../fixtures/board.js';
import {
  runFixtureGit,
  runFixtureSetupGit,
} from '../../fixtures/child.js';
import { temporaryRepository } from '../../fixtures/board/submit.js';

const AT = '2026-11-18T00:00:00.000Z';

/** A repository with main and one commit naming item 1, and a board holding item 1 in the given status and item 2. */
function carried(t, status) {
  const root = temporaryRepository(t, 'pullboard-wrong-branch-');
  const trunk = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  writeFileSync(join(root, 'carried.txt'), 'carried over from the first item\n');
  runFixtureGit(['add', 'carried.txt'], { cwd: root });
  runFixtureSetupGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'test: carried [G1]', '-m', 'Pullboard-Item: #1'], { cwd: root });
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const board = fixtureBoard(t);
  const insert = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES (\x27web\x27, ?, \x27The guard holds.\x27, ?, \x27coordinator\x27, ?, ?)`);
  insert.run('First item', status, AT, AT);
  insert.run('Replacement item', 'open', AT, AT);
  return { root, board, head, trunk: { ref: 'main', commit: trunk }, replacement: { item_id: 2 } };
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
  const submitted = carried(t, 'claimed');
  assert.throws(() => refuseUnsubmittableStack(submitted.root, submitted.board, submitted.replacement, submitted.head, submitted.trunk), (error) => error.code === 'WRONG_BRANCH');
});
