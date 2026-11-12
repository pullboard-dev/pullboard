/** A locally accepted old head must not accept a peer's later submission at replay [H21,V1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import { captureBoardChanges } from '../../../../../../packages/store/index.js';
import {
  applyEngineMove,
  engineReceipt,
  prepareEngineMove,
} from '../../../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../../packages/store/index.js';
import {
  leaveConflictNotice,
  takeConflictNotices,
} from '../../../../../../packages/outbox/index.js';
import {
  earlierMoves,
  refusalLine,
} from '../../../../../../packages/outbox/index.js';
import { undoQueued } from '../../../../../../packages/outbox/index.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../../tests/fixtures/testkit.js';

/** Make genuine native submitted history, then freeze the public replay test's immutable policy. */
function submittedBoard(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Relay local-first verdict fixture model';
  const box = helpers.project(undefined, isolated);
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) store.closeBoard(handle);
    helpers.cleanup();
  });
  const added = fixtureAdd(box.run, box.repo, 'web', 'A queued verdict keeps its reviewed head', '--specs', 'G1',
    '--criterion', 'The page renders. [test]');
  assert.equal(added.code, 0, added.err + added.out);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/page.html', '<h1>Old head</h1>',
    'feat(web): render the private page [G1]').status, 0);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { isMain: true, gitRoot: box.repo });
  handles.push(board);
  const item = store.getItem(board, 1);
  const frozen = JSON.parse(item.item_frozen);
  assert.equal(frozen.policy, undefined, 'the native freeze holds the bar alone; the verdict carries its policy [B4]');
  // Synthetic replay actors use native registration, not forged credentials or a production board.
  const reviewer = store.register(board, { lane: 'web', path: join(box.dir, 'offline-reviewer') });
  const peer = store.register(board, { lane: 'web', path: join(box.dir, 'peer-reviewer') });
  return { box, helpers, board, item, reviewer, peer, handles };
}

/** Bind a verdict to the submitted and checked head, using the current native review wire shape. */
function verdict(item, actor, decision, trunk) {
  return { agentId: actor, decision, ...(decision === 'REJECT' ? { reason: 'OTHER', clause: 'The page renders.' } : {}),
    note: 'Replay semantics fixture; this verdict is not proof of a product gate.',
    head: item.item_commit, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
    review: { commit: item.item_commit, head: item.item_commit, trunk, paths: ['web/page.html'] } };
}

/** Replay one fixed move with a deterministic timestamp, so both real SQLite copies see the same order. */
function apply(board, move, sequence) {
  return applyEngineMove(board, move, { sequence, at: `2026-10-26T00:00:0${sequence}.000Z` });
}

test('a queued accept for an old head is refused after a peer resubmission on both replicas [H21,V1,H16]', async t => {
  const { box, helpers, board, item, reviewer, peer, handles } = submittedBoard(t);
  const directory = join(box.dir, 'replay-copies');
  mkdirSync(directory);
  const snapshot = exportBoard(board);
  const copies = ['offline', 'peer'].map(name => {
    const copy = openBoard(join(directory, `${name}.sqlite`), undefined, { isMain: false, gitRoot: box.repo });
    importBoard(copy, snapshot);
    handles.push(copy);
    return copy;
  });
  const [offline, online] = copies;
  const trunk = box.git(box.repo, 'rev-parse', 'HEAD');
  const queued = prepareEngineMove(offline, 'verify', [1, verdict(item, reviewer, 'ACCEPT', trunk)],
    { id: 'offline-accept-old-head', actor: reviewer });
  const counters = offline.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();
  const captured = await captureBoardChanges(() => store.verify(offline, 1, queued.args[1]));
  assert.equal(store.getItem(offline, 1).item_status, 'verified', 'the old head is accepted on this replica before sync');

  const rejection = prepareEngineMove(online, 'verify', [1, verdict(item, peer, 'REJECT', trunk)],
    { id: 'peer-rejects-old-head', actor: peer });
  assert.equal(apply(online, rejection, 1).error, undefined);
  const frozen = item.item_frozen;
  const claim = prepareEngineMove(online, 'claim', [1, { agentId: item.item_built_by, lane: 'web', leaseMs: 3_600_000,
    head: item.item_commit, freeze: () => ({ text: frozen, digest: createHash('sha256').update(frozen).digest('hex') }) }],
  { id: 'peer-claims-rework', actor: item.item_built_by });
  assert.equal(apply(online, claim, 2).error, undefined);
  assert.equal(helpers.commitFile(box, box.web, 'web/page.html', '<h1>Updated head</h1>',
    'feat(web): update the private page [G1]').status, 0);
  const nextCommit = box.git(box.web, 'rev-parse', 'HEAD');
  const nextTree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  // Only this replacement submission is synthetic: its descriptor explicitly declares that it ran no gate.
  const submission = prepareEngineMove(online, 'submit', [1, { agentId: item.item_built_by, commit: nextCommit, policyCommit: trunk,
    tree: nextTree, submissionProof: { version: 1, files: [], full: false, deferred: true,
      reason: 'synthetic resubmission for replay semantics; no gate execution' } }],
  { id: 'peer-submits-new-head', actor: item.item_built_by });
  assert.equal(apply(online, submission, 3).error, undefined);
  assert.equal(store.getItem(online, 1).item_commit, nextCommit);
  assert.equal(undoQueued(offline, [{ sequences: counters,
    changes: captured.changes.map(change => Buffer.from(change).toString('base64')) }]), null);
  assert.equal(store.verdictsFor(offline, 1).length, 0, 'the speculative accept is taken back before ordered replay');
  for (const [index, move] of [rejection, claim, submission].entries()) assert.equal(apply(offline, move, index + 1).error, undefined);

  for (const copy of copies) {
    const before = store.verdictsFor(copy, 1);
    const outcome = apply(copy, queued, 4);
    assert.equal(outcome.error?.code, 'BAD_VERDICT_REVIEW', 'the sealed review binds the old head, not the current submission');
    assert.equal(store.getItem(copy, 1).item_status, 'submitted');
    assert.equal(store.getItem(copy, 1).item_commit, nextCommit);
    assert.deepEqual(store.verdictsFor(copy, 1), before, 'no acceptance is attributed to the replacement head');
    const receipt = engineReceipt(copy, queued.id);
    assert.deepEqual(apply(copy, queued, 4), outcome, 'an exact retry returns the original refusal');
    assert.deepEqual(engineReceipt(copy, queued.id), receipt, 'retry leaves one immutable receipt');
  }
  assert.deepEqual(exportBoard(offline), exportBoard(online), 'both replicas converge including the refused receipt');
  const earlier = earlierMoves(offline, { move: queued, after: 0 }, 4);
  const line = refusalLine({ move: `verify #1 by ${reviewer}`, queuedAt: '2026-10-26T00:00:00.000Z',
    ...engineReceipt(offline, queued.id).outcome.error, earlier });
  assert.match(line, /BAD_VERDICT_REVIEW/u);
  assert.ok(line.includes(`won by sequence 3 submit #1 by ${item.item_built_by}`), 'the refusal names the superseding submit and builder');
  const linkFile = join(directory, 'relay.json');
  leaveConflictNotice(linkFile, 'offline-reviewer', line);
  assert.deepEqual(takeConflictNotices(linkFile, 'offline-reviewer'), [line]);
  assert.deepEqual(takeConflictNotices(linkFile, 'offline-reviewer'), [], 'the losing reviewer is told once');
});
