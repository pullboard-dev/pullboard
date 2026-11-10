/** Companion changes retain review custody while invalidating the checked inputs [V15,V4,H16,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { main } from '../../../tests/fixtures/native.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { itemPatchDigest } from '../../../../../packages/items/index.js';
import { PATCH_REVIEW_CUSTODY_ENGINE } from '../../../../../packages/state/light.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';

const HALF_HOUR = 1_800_000;
const PATCH = 'diff --git a/web/example.js b/web/example.js\n--- a/web/example.js\n+++ b/web/example.js\n@@ -1 +1 @@\n-old\n+new\n';

/** Use real Git worktrees and a persisted board shared by the CLI and native moves. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-review-custody-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Review fixture', GIT_AUTHOR_EMAIL: 'review@example.invalid',
    GIT_COMMITTER_NAME: 'Review fixture', GIT_COMMITTER_EMAIL: 'review@example.invalid' };
  /** Execute private Git with its own identity and no global configuration. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, review: { owns: [], specs: ['G1'] } }, shared: [] }));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n## G\n- G1 [approved, must] Retain review custody. | gate: true\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'test: private review custody fixture');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const tree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
  const paths = ['builder', 'reviewer', 'other'].map(name => join(directory, name));
  for (const path of paths) git(root, 'worktree', 'add', '-q', '--detach', path, head);
  let at = Date.parse('2026-10-28T05:03:07.314Z');
  const clock = { now: () => new Date(at), advance: ms => { at += ms; } };
  // @pullboard-board-file persistence: the real CLI reopens this Git board to observe the reservation through another connection.
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: root });
  const builder = store.register(board, { lane: 'web', path: paths[0], family: 'Fixture Builder' });
  const reviewer = store.register(board, { lane: 'review', path: paths[1], family: 'Fixture Reviewer' });
  const other = store.register(board, { lane: 'review', path: paths[2], family: 'Fixture Other Reviewer' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Review custody fixture', specs: 'G1' });
  const frozen = JSON.stringify({ rows: [], check: 'true' });
  const digest = createHash('sha256').update(frozen).digest('hex');
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HALF_HOUR, head,
    freeze: () => ({ text: frozen, digest }) });
  submitFixture(board, id, { agentId: builder, commit: head, tree });
  /** Call the same ordered reservation used by next --verify. */
  const reserve = agentId => store.reserveReview(board, id, { agentId, leaseMs: HALF_HOUR, policy: 'any' });
  /** Attach immutable real diff bytes to the exact submitted source. */
  const attach = key => store.attachItemPatch(board, id, { agentId: 'coordinator', key, commit: head, patch: PATCH, author: builder });
  /** Exercise native verdict input validation; this fixture does not claim to run a gate. */
  const verdict = companionDigest => store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT',
    head, digest, policy: 'any', companionDigest, note: 'Synthetic state control: freshly captured companion digest; no runtime proof claimed.' });
  return { board, id, clock, root, head, builder, reviewer, other, otherPath: paths[2], reserve, attach, verdict };
}

/** Capture the real CLI against a separate connection to the fixture's persisted board. */
async function nextVerify(box) {
  let stdout = '', stderr = '';
  const code = await main(['next', '--verify', '--json'], { cwd: box.otherPath, clock: box.clock,
    stdout: { isTTY: false, write: part => { stdout += part; } }, stderr: { write: part => { stderr += part; } } });
  return { code, stdout, stderr };
}

test('companion rebinding preserves the live reviewer and refuses the previous checked inputs [V15,V4,H16,C7]', async t => {
  const box = fixture(t);
  box.attach('old-source-part');
  const previousProof = itemPatchDigest(box.board, box.id);
  const reserved = box.reserve(box.reviewer);
  box.clock.advance(85_900);
  box.attach('rebound-source-part');
  store.removeItemPatch(box.board, box.id, { agentId: 'coordinator', key: 'old-source-part' });
  const item = store.getItem(box.board, box.id);
  assert.equal(item.item_review_by, box.reviewer, 'the original reviewer retains custody across attach and removal');
  assert.equal(item.item_review_until, reserved.item_review_until, 'companion changes do not renew or shorten the lease');
  const before = exportBoard(box.board);
  assert.throws(() => box.reserve(box.other), error => error.code === 'REVIEW_HELD' && error.message.includes(box.reviewer));
  assert.throws(() => store.release(box.board, box.id, box.other, 'Not my reservation', 'OTHER'), { code: 'NOT_YOURS' });
  assert.throws(() => box.verdict(previousProof), { code: 'ITEM_PATCH_CHANGED' });
  assert.deepEqual(exportBoard(box.board), before, 'refused reservation, release and stale verdict have no effects');
  const offered = await nextVerify(box);
  assert.equal(offered.code, 1, offered.stdout + offered.stderr);
  assert.match(offered.stdout + offered.stderr, new RegExp(box.reviewer, 'u'));
  assert.equal(store.getItem(box.board, box.id).item_review_by, box.reviewer, 'the CLI cannot steal the reservation');
  box.verdict(itemPatchDigest(box.board, box.id));
  assert.equal(store.getItem(box.board, box.id).item_status, 'verified', 'the current input digest remains acceptable to its reviewer');
});

test('a reservation can be renewed by its holder and expires without blocking the next reviewer [V15,C7]', t => {
  const box = fixture(t);
  box.reserve(box.reviewer);
  box.clock.advance(60_000);
  const renewed = box.reserve(box.reviewer);
  box.attach('during-renewed-review');
  assert.equal(store.getItem(box.board, box.id).item_review_until, renewed.item_review_until);
  box.clock.advance(HALF_HOUR);
  assert.equal(box.reserve(box.other).item_review_by, box.other, 'a lease is free at its exact expiry');
  assert.throws(() => store.release(box.board, box.id, box.reviewer, 'My earlier lease expired', 'OTHER'), { code: 'NOT_YOURS' });
  assert.equal(store.getItem(box.board, box.id).item_review_by, box.other);
});

test('changed companion inputs still revoke acceptance when no submitted review is live [V4,H16,C7]', t => {
  const box = fixture(t);
  box.verdict(undefined);
  box.attach('after-acceptance');
  const item = store.getItem(box.board, box.id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_verdict, null);
  assert.equal(item.item_verified_by, null);
  assert.equal(item.item_review_by, null);
  assert.equal(item.item_review_until, null);
});

test('older ordered companion changes replay eviction and the new engine retains custody [V15,H16,C7]', t => {
  const box = fixture(t);
  const held = box.reserve(box.reviewer);
  const options = { agentId: 'coordinator', key: 'ordered-part', commit: box.head, patch: PATCH, author: box.builder };
  const move = prepareEngineMove(box.board, 'attachItemPatch', [box.id, options], { id: 'review-custody-order' });
  assert.ok(move.engine >= PATCH_REVIEW_CUSTODY_ENGINE, 'the producer stamps the engine that defines retained custody');
  for (const engine of [PATCH_REVIEW_CUSTODY_ENGINE - 1, PATCH_REVIEW_CUSTODY_ENGINE]) {
    const replica = openBoard(':memory:', box.clock);
    t.after(() => store.closeBoard(replica));
    importBoard(replica, exportBoard(box.board));
    const outcome = applyEngineMove(replica, { ...move, engine }, { sequence: 1, at: box.clock.now().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    const item = store.getItem(replica, box.id);
    assert.equal(item.item_review_by, engine < PATCH_REVIEW_CUSTODY_ENGINE ? null : box.reviewer);
    assert.equal(item.item_review_until, engine < PATCH_REVIEW_CUSTODY_ENGINE ? null : held.item_review_until);
    assert.deepEqual(applyEngineMove(replica, { ...move, engine }, { sequence: 1, at: box.clock.now().toISOString() }), outcome,
      'an identical ordered retry retains its original receipt and custody');
  }
});
