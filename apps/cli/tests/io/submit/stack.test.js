/** A submit stacked on another item's unverified commit is refused, and a base that is verified or already on main is not [H3,H16,V1,V17]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { refuseUnsubmittableStack } from '../../../src/io/submit.js';
import * as store from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../../fixtures/board.js';
import {
  runFixtureGit,
  runFixtureSetupGit,
} from '../../fixtures/child.js';
import {
  submitFixture,
  temporaryRepository,
} from '../../fixtures/board/submit.js';

const AT = '2026-10-23T00:00:00.000Z';

/** Commit one file on the current branch and return the new head. */
function commit(root, file, text) {
  writeFileSync(join(root, file), text);
  runFixtureGit(['add', file], { cwd: root });
  runFixtureSetupGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', `test: ${file} [G1]`], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/** A repository with main, a base item's commit stacked on it, and a board holding both items. */
function stacked(t, baseStatus) {
  const root = temporaryRepository(t, 'pullboard-stack-');
  const trunk = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const base = commit(root, 'recovery-a.txt', 'the first submitted commit\n');
  const head = commit(root, 'recovery-b.txt', 'the stacked candidate\n');
  const board = fixtureBoard(t);
  const agent = 'web-1';
  board.db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)').run(agent, 'web', join(root, 'seat'), AT);
  const insert = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES ('web', ?, 'The stack guard holds.', 'open', 'coordinator', ?, ?)`);
  insert.run('Stack base', AT, AT);
  insert.run('Stacked item', AT, AT);
  const freeze = () => ({ text: 'bar', digest: 'digest:bar' });
  store.claim(board, 1, { agentId: agent, lane: 'web', leaseMs: 3_600_000, freeze });
  if (baseStatus !== 'claimed') submitFixture(board, 1, { agentId: agent, commit: base, tree: runFixtureGit(['rev-parse', `${base}^{tree}`], { cwd: root }) });
  return { root, board, trunk: { ref: 'main', commit: trunk }, base, head, candidate: { item_id: 2 } };
}

test('cli.io-submit-stack.stack-refusal-a-head-containing-another-item: stack refusal: a head containing another item\'s unverified submitted commit is refused with that item named [H3,H16,V1,V17]', t => {
  const { root, board, trunk, base, head, candidate } = stacked(t, 'submitted');
  assert.throws(() => refuseUnsubmittableStack(root, board, candidate, head, trunk),
    error => error.code === 'STACKED_ON_UNVERIFIED' && error.message.includes('#1') && error.message.includes(base));
});

test('cli.io-submit-stack.stack-refusal-a-base-never-submitted-or: stack refusal: a base never submitted, or a head that does not contain it, is not a stack [H3,H16,V1,V17]', t => {
  const unsubmitted = stacked(t, 'claimed');
  assert.doesNotThrow(() => refuseUnsubmittableStack(unsubmitted.root, unsubmitted.board, unsubmitted.candidate, unsubmitted.head, unsubmitted.trunk),
    'a base that was never submitted holds no unverified commit');
  const open = stacked(t, 'submitted');
  assert.doesNotThrow(() => refuseUnsubmittableStack(open.root, open.board, open.candidate, open.trunk.commit, open.trunk),
    'a head at main contains no unverified commit');
});

test('cli.io-submit-stack.stack-refusal-the-base-item-itself-is: stack refusal: the base item itself is never refused for its own commit, and a trunk that cannot be read refuses with its own code [H3,H16,V1,V17]', t => {
  const { root, board, trunk, head } = stacked(t, 'submitted');
  assert.doesNotThrow(() => refuseUnsubmittableStack(root, board, { item_id: 1 }, head, trunk));
  assert.throws(() => refuseUnsubmittableStack(root, board, { item_id: 2 }, head, { ref: 'main', commit: 'e'.repeat(40) }), error => error.code === 'NO_POLICY');
});

test('cli.io-submit-stack.stack-refusal-an-unverified-commit-already-merged: stack refusal: an unverified commit already merged into trunk is outside the candidate range, so a head above it is not stacked [V17,V1]', t => {
  const { root, board, base, head, candidate } = stacked(t, 'submitted');
  assert.doesNotThrow(() => refuseUnsubmittableStack(root, board, candidate, head, { ref: 'main', commit: base }));
});
