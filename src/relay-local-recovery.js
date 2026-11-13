/** Explicit operator-selected loss of unpublished local moves, not fabricated relay refusals [H16,H21]. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appliedSequence } from './engine.js';
import { exportBoard, restoreRelaySnapshot, semanticBoardDigest } from './exchange.js';
import { outboxFile, readOutbox } from './relay-outbox.js';
import { withOutboxGuard } from './relay-outbox-guard.js';
import { readBoardKey } from './relay-key.js';
import { Refused } from './refused.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const refusal = text => new Refused('RELAY_LOCAL_RECOVERY', text);
const nativeDigest = board => semanticBoardDigest(exportBoard(board));

/** Preserve every existing ordered outcome exactly; loss permission applies only to local unpublished work. */
function preservesReceipts(before, after) {
  const meta = new Map(after.tables.board_meta.map(row => [row.meta_key, row.meta_value]));
  if (before.tables.board_meta.some(row => /^relay_(receipt|refusal)_/u.test(row.meta_key) && meta.get(row.meta_key) !== row.meta_value)) {
    throw refusal('the authenticated prefix disagrees with an existing receipt; no local recovery was applied');
  }
}

/**
 * Caller holds the ordinary relay lock and has quiesced native writers, checkpoint publishers and old callers.
 * The exact queue digest is the loss selection, not an authentication credential. Only the existing machine's
 * authenticated relay prefix is adopted. No POST/PUT, queued operation, person event or invented refusal is made.
 * A durable existing recovery hold fences ordinary traffic across each local crash cut; retry the same selection.
 * io.recoveryCut is an injectable fixture cut, never an alternate persistence or authority path.
 */
export async function discardUnpublished(link, { queueSha256, decision }) {
  const { root, file, state, io, localRecords, saveLink, loadLink } = link;
  if (!/^[0-9a-f]{64}$/u.test(queueSha256 ?? '') || typeof decision !== 'string' || !decision.trim() || decision.length > 2000) {
    throw refusal('supply the exact inspected queue SHA-256 and attributable loss decision');
  }
  if (state.mode !== 'ordered' || state.unlinking || state.environment || state.baselineAccepted === false) {
    throw refusal('recover only an existing accepted machine-owned ordered board');
  }
  const directory = join(dirname(file), 'local-recovery', queueSha256);
  const queueFile = outboxFile(file), archive = join(directory, 'outbox.sealed');
  const planFile = join(directory, 'plan.json');
  const key = readBoardKey(state.board);
  if (!state.recovery && state.localRecovery?.kind === 'discard-unpublished' && state.localRecovery.queueSha256 === queueSha256 && state.localRecovery.decision === decision) {
    if (!existsSync(archive) || digest(readFileSync(archive)) !== queueSha256 || digest(readFileSync(planFile)) !== state.localRecovery.planSha256) {
      throw refusal('the completed recovery custody changed; do not repeat the reset');
    }
    return { board: state.board, sequence: state.localRecovery.sequence, queueSha256, alreadyCompleted: true, archive, plan: planFile,
      disposition: 'read back the original recovery completion; later native work was not reset' };
  }
  let marker = state.recovery;
  if (marker && (marker.kind !== 'discard-unpublished' || marker.queueSha256 !== queueSha256 || marker.decision !== decision)) {
    throw refusal('another recovery selection is pending; preserve it and finish that exact selection');
  }
  if (!marker) {
    if (!existsSync(queueFile) || digest(readFileSync(queueFile)) !== queueSha256) throw refusal('the local queue changed or is absent; no recovery applied');
    const original = localRecords(root, exportBoard);
    const sourceDigest = semanticBoardDigest(original);
    const initialLink = digest(readFileSync(file));
    const queue = await readOutbox(queueFile, key, state.board);
    if (!queue?.moves?.length) throw refusal('this selection has no queued moves');
    let checkpoint = await link.fetchCheckpoint(key);
    const records = [];
    let after = checkpoint.sequence;
    for (;;) {
      const page = await link.request(state, '/api/v1/boards/' + state.board + '/events?after=' + after, { method: 'GET' }, io);
      if (!Array.isArray(page.events) || page.events.some((record, i) => record?.event_id !== after + i + 1 || !['move', 'request'].includes(record.kind) || typeof record.sealed !== 'string')) {
        throw refusal('the relay did not supply a contiguous authenticated-prefix candidate');
      }
      if (!page.events.length) break;
      records.push(...page.events); after = records.at(-1).event_id;
    }
    const minimum = Math.max(queue.baseSequence, localRecords(root, appliedSequence), checkpoint.sequence);
    checkpoint = await link.advanceCheckpoint(key, checkpoint, records, minimum);
    preservesReceipts(original, checkpoint.native);
    const targetDigest = semanticBoardDigest(checkpoint.native);
    const receipts = new Map(checkpoint.native.tables.board_meta.map(row => [row.meta_key, row.meta_value]));
    // The individual identities remain in encrypted custody; the report never calls abandonment absence or success.
    const plan = { version: 1, board: state.board, queueSha256, decision, sourceDigest, targetDigest,
      sequence: checkpoint.sequence, queued: queue.moves.length, native: checkpoint.native,
      previousLinkState: { pending: state.pending ?? null, recovered: state.recovered ?? null,
        snapshot: state.snapshot ?? null, checkpoint: state.checkpoint ?? null },
      originalReceiptCount: [...receipts.keys()].filter(key => key.startsWith('relay_receipt_')).length };
    await withOutboxGuard(file, () => {
      if (digest(readFileSync(file)) !== initialLink || digest(readFileSync(queueFile)) !== queueSha256 || localRecords(root, nativeDigest) !== sourceDigest) {
        throw refusal('local state changed during preparation; no recovery applied');
      }
      // Reusing an uncommitted staged plan is not a state effect. It is safe to replace only under unchanged inputs.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const bytes = JSON.stringify(plan);
      const temporary = planFile + '.tmp';
      writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, planFile);
      marker = { kind: 'discard-unpublished', queueSha256, decision, planSha256: digest(bytes), sourceDigest, targetDigest, sequence: checkpoint.sequence };
      state.recovery = marker; saveLink(file, state);
    });
    await io.recoveryCut?.('held');
  }
  return withOutboxGuard(file, async () => {
    const current = loadLink(file);
    if (JSON.stringify(current.recovery) !== JSON.stringify(marker)) throw refusal('the selected recovery hold changed');
    const bytes = readFileSync(planFile);
    if (digest(bytes) !== marker.planSha256) throw refusal('the retained recovery plan changed; keep its hold');
    const plan = JSON.parse(bytes);
    if (plan.board !== state.board || plan.queueSha256 !== queueSha256 || plan.decision !== decision || plan.sourceDigest !== marker.sourceDigest || plan.targetDigest !== marker.targetDigest || plan.sequence !== marker.sequence || semanticBoardDigest(plan.native) !== marker.targetDigest) {
      throw refusal('the retained plan does not match this board and recovery selection');
    }
    let actual = localRecords(root, nativeDigest);
    if (![marker.sourceDigest, marker.targetDigest].includes(actual)) throw refusal('native state changed after the recovery hold; keep it and reconcile that writer');
    if (existsSync(queueFile)) {
      if (digest(readFileSync(queueFile)) !== queueSha256 || existsSync(archive)) throw refusal('the active or archived queue changed; no replacement is allowed');
      renameSync(queueFile, archive);
    }
    if (!existsSync(archive) || digest(readFileSync(archive)) !== queueSha256) throw refusal('original encrypted queue custody is missing; keep the recovery hold');
    await io.recoveryCut?.('archived');
    if (actual !== marker.targetDigest) {
      localRecords(root, board => restoreRelaySnapshot(board, plan.native, plan.sequence, marker.sourceDigest));
      actual = localRecords(root, nativeDigest);
      if (actual !== marker.targetDigest) throw refusal('native recovery readback differs; keep the recovery hold');
    }
    await io.recoveryCut?.('restored');
    rmSync(join(dirname(file), 'relay-outbox.summary.json'), { force: true });
    for (const name of ['pending', 'recovered', 'snapshot', 'checkpoint', 'outbox', 'recovery']) delete current[name];
    current.sequence = plan.sequence;
    // Mirror cursor names native event IDs, not relay positions; retain that distinction after a lossy rebase.
    current.cursor = localRecords(root, board => board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id);
    current.localRecovery = { kind: 'discard-unpublished', queueSha256, decision, sequence: plan.sequence, planSha256: marker.planSha256 };
    saveLink(file, current);
    Object.keys(state).forEach(key => delete state[key]); Object.assign(state, current);
    return { board: state.board, sequence: plan.sequence, queueSha256, retiredQueuedEntries: plan.queued,
      archive, plan: planFile, originalReceiptCount: plan.originalReceiptCount,
      disposition: 'authenticated ordered baseline restored; unpublished local messages abandoned, not declared absent or successful' };
  });
}
