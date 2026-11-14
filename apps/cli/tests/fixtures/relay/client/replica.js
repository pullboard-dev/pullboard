/** Read and replay fixture replica state without changing its durable history [H16,V1,V17]. */
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { unseal } from '../../../../../../packages/kernel/index.js';
import { syncRelay } from '../../../../../../packages/link/index.js';
import * as store from '../../../../../../packages/store/index.js';
import { apiBoardOpeners } from '../../board.js';
import { openBoardForRead } from '../../../../../lib/index.js';

/** Read local events directly so inspection itself cannot drain the durable retry queue. */
export function localEvents(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(JSON.stringify(db.prepare('SELECT * FROM event ORDER BY event_id').all())); }
  finally { db.close(); }
}

/** Read replay receipts without changing either replica's event cursor. */
export function receipts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'")
      .all().map(({ meta_value }) => JSON.parse(meta_value));
  } finally { db.close(); }
}

/** Keep each replica's complete ordered refusal envelope identical for a competing item claim [H16]. */
export function assertReplicaClaimErrorEquality(receiptRows, itemId) {
  const errors = receiptRows.map((rows, index) => {
    const denied = rows.map((receipt) => ({ receipt, move: JSON.parse(receipt.move) }))
      .filter(({ receipt, move }) => move.operation === 'claim' && move.args[0] === itemId && receipt.outcome.error);
    assert.equal(denied.length, 1, `replica ${index + 1} has one durable refusal for item #${itemId}`);
    return denied[0].receipt.outcome.error;
  });
  for (const error of errors.slice(1)) {
    assert.deepEqual(error, errors[0], `every replica preserves the full refusal envelope for item #${itemId}`);
  }
}

/** Decode only stable operation identity fields from captured fixture relay posts. */
export async function relayUploadSummary(uploads, key, boardId) {
  return Promise.all(uploads.map(async ({ sequence, sealed }) => {
    const plain = await unseal(key, Buffer.from(sealed, 'base64url'), { boardId, kind: 'move', sequence });
    const move = JSON.parse(new TextDecoder().decode(plain));
    return { sequence, operation: move.operation, moveId: move.id,
      itemId: move.operation === 'recordProofRun' ? move.args?.[0]?.itemId
        : ['submit', 'appendFact'].includes(move.operation) && Number.isSafeInteger(move.args?.[0]) ? move.args[0] : null,
      commit: move.operation === 'submit' ? move.args?.[1]?.commit ?? null : null,
      recipient: move.operation === 'recordActivityDelivery' ? move.args?.[0]?.agentId ?? null : null };
  }));
}

/** The gate-offer notes a pulled submit orders for one item: the one move its own command sends [C7,P7]. */
function offerNotes(moves, itemId) {
  return moves.filter(({ operation, itemId: noted }) => operation === 'appendFact' && noted === itemId);
}

/**
 * Bind a pulled stacked submit's lost note, the later submit and the sync to their exact durable outcomes [H16,C7].
 * Why no submit move: a pulled submit orders only its gate-offer note and the board's submit comes from the runner's
 * receipt, so a lost reply recovered here must never have sent a submit of its own.
 */
export async function assertRecoveredStackUploads({ uploads, bounds, key, boardId, replicaFiles, stackedA, stackedB, lostNote }) {
  const stackBoardA = openBoardForRead(replicaFiles[0]);
  const stackBoardB = openBoardForRead(replicaFiles[1]);
  let stackOwnerA;
  let stackOwnerB;
  try {
    stackOwnerB = store.getItem(stackBoardA, stackedB).item_owner;
    stackOwnerA = store.getItem(stackBoardB, stackedA).item_owner;
  } finally {
    store.closeBoard(stackBoardA);
    store.closeBoard(stackBoardB);
  }
  const recoveredReceipt = receipts(replicaFiles[0]).find((receipt) => JSON.parse(receipt.move).id === lostNote.id);
  assert.deepEqual(JSON.parse(recoveredReceipt?.move ?? 'null'), lostNote,
    'the note whose reply was lost has its exact durable engine receipt');

  const [lostBMoves, submitAMoves, syncAMoves] = await Promise.all([
    relayUploadSummary(uploads.slice(bounds.beforeRecoveredStack, bounds.afterLostStackSubmit), key, boardId),
    relayUploadSummary(uploads.slice(bounds.afterLostStackSubmit, bounds.afterLaterA), key, boardId),
    relayUploadSummary(uploads.slice(bounds.afterLaterA, bounds.afterStackRecovery), key, boardId),
  ]);
  assert.deepEqual(offerNotes(lostBMoves, stackedB).map(({ moveId }) => moveId), [lostNote.id],
    'B uploads its one gate-offer note, the move whose reply was lost');
  assert.deepEqual([...lostBMoves, ...submitAMoves].filter(({ operation }) => operation === 'submit'), [],
    'neither pulled submit sends a submit move; the runner receipt orders it');
  assert.equal(offerNotes(submitAMoves, stackedA).length, 1, 'A orders its one gate-offer note');
  assert.deepEqual(submitAMoves.filter(({ operation }) => operation === 'recordActivityDelivery').map(({ recipient }) => recipient),
    [stackOwnerA], 'A records its one activity delivery');
  assert.deepEqual(syncAMoves, [], 'sync after the lost reply creates no relay moves: the note already reached the relay');
  return stackOwnerB;
}

/** Require a retried submit to reuse the original gate job: only its activity delivery, never a note or a submit [H16,C7]. */
export async function assertOriginalOutcomeDelivery(uploads, key, boardId, submitter) {
  const moves = await relayUploadSummary(uploads, key, boardId);
  assert.deepEqual(moves.map(({ operation }) => operation), ['recordActivityDelivery'],
    'the retry reuses the open gate job and orders only its activity delivery, never a proof run or a submit');
  assert.equal(moves[0].recipient, submitter);
}

/**
 * Count the relay uploads once earlier commands have finished sending. A detached sender can land a
 * move from an earlier command (for example the review comparison fact `pullboard verify` appends,
 * apps/cli/src/io/commands/verify.js) inside a later window, so the count is taken only after
 * status round trips find the outbox empty and the upload count unchanged twice in a row [H16,C7].
 */
export async function settledUploadCount(relay, status) {
  let stable = 0;
  let seen = -1;
  for (let attempt = 0; attempt < 40 && stable < 2; attempt += 1) {
    const { relay: link } = await status();
    stable = (link?.outbox ?? []).length === 0 && relay.uploads.length === seen ? stable + 1 : 0;
    seen = relay.uploads.length;
  }
  assert.equal(stable, 2, 'the relay outbox settles');
  return relay.uploads.length;
}

/** Make a submitted commit locally verifiable by the other replica's real Git history. */
export function mergeCandidateForReview(root, env, sourceRoot, commit, gitAt) {
  gitAt(root, env, 'fetch', sourceRoot, commit);
  gitAt(root, env, 'merge', '--no-ff', '-m', 'test: make submitted commit available to verifier [G1]', 'FETCH_HEAD');
  gitAt(root, env, 'merge-base', '--is-ancestor', commit, 'HEAD');
}

/** Replay a fixture clone's real outbox through the production sync path without another CLI process. */
export async function syncReplica(root, env) {
  const keys = ['HOME', 'USERPROFILE', 'PULLBOARD_HOME', 'PULLBOARD_RELAY_TOKEN', 'PULLBOARD_RELAY_SENDER_BACKGROUND',
    'PULLBOARD_RELAY_CHECKPOINT_BACKGROUND', 'PULLBOARD_RELAY_CHECKPOINT_QUIET_MS', 'PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const diagnostics = [];
  try {
    const result = await syncRelay(root, { ...apiBoardOpeners, relayOutbox: () => true, err: line => diagnostics.push(line), say: () => {} });
    return { result, diagnostics };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
