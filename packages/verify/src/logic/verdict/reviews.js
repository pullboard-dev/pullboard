import { advancedVerdict } from '../advance.js';
/** Sealed review validation and immutable acceptance projections [E8,H16]. */
import { verdictWithdrawals } from '../../io/verdict/withdrawal.js';
import { Refused } from '../../../../kernel/light.js';
import { verdictRows } from '../../../../seats/light.js';
import { itemPatchDigest } from '../../../../items/light.js';

/** Validate a sealed review without consulting Git or changing either replica [E8,H16]. */
export function verdictReviewProblem(review, commit, { checked } = {}) {
  const valid = review && typeof review === 'object' && !Array.isArray(review)
    && Object.keys(review).sort().join(',') === (checked === false ? 'commit,paths,trunk' : checked === true || Object.hasOwn(review, 'head') ? 'commit,head,paths,trunk' : 'commit,paths,trunk')
    && (!checked || Object.hasOwn(review, 'head'))
    && (!Object.hasOwn(review, 'head') || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(review.head ?? ''))
    && review.commit === commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(review.commit ?? '')
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(review.trunk ?? '')
    && Array.isArray(review.paths) && review.paths.every(path => typeof path === 'string' && !path.includes('\0')
      && path.split('/').every(part => part && part !== '.' && part !== '..'))
    && JSON.stringify(review.paths) === JSON.stringify([...new Set(review.paths)].sort());
  return valid ? null : new Refused('BAD_VERDICT_REVIEW', checked ? 'the review must bind the current submitted commit, its checked commit, reviewed trunk and sorted unique candidate paths; use current Pullboard to review it again' : 'the review must bind the current submitted commit, its reviewed trunk and sorted unique candidate paths; use current Pullboard to review it again');
}

/**
 * Every verdict row, verdict receipt and reopen of many items, each read once and grouped by item [C7].
 * Why: a cold state build asked for each item's verdicts one query at a time; this is the one pass it takes instead.
 *
 * @param {any} board
 * @param {Iterable<number>} ids
 * @returns {{ verdicts: Map<number, any[]>, receipts: Map<number, any[]>, reopens: Map<number, any[]> }}
 */
export function verdictReads(board, ids) {
  const grouped = new Map([...ids].map(id => [id, { verdicts: [], receipts: [], reopens: [] }]));
  for (const row of board.db.prepare('SELECT verdict.* FROM verdict JOIN item USING (item_id) ORDER BY verdict_id').all()) grouped.get(row.item_id)?.verdicts.push(row);
  for (const row of board.db.prepare("SELECT event_id, item_id, event_kind, event_detail FROM event WHERE event_kind IN ('accept', 'reject') ORDER BY event_id").all()) grouped.get(row.item_id)?.receipts.push(row);
  for (const row of board.db.prepare("SELECT * FROM event WHERE event_kind = 'reopen' ORDER BY event_id").all()) grouped.get(row.item_id)?.reopens.push(row);
  const pick = key => new Map([...grouped].map(([id, rows]) => [id, rows[key]]));
  return { verdicts: pick('verdicts'), receipts: pick('receipts'), reopens: pick('reopens') };
}

/**
 * Every verdict on an item, oldest first.
 *
 * @param {any} board
 * @param {number} id
 * @param {ReturnType<typeof verdictReads>} [reads] rows read ahead for many items; an item they omit is read on its own
 * @returns {any[]}
 */
export function verdictsFor(board, id, reads) {
  const ahead = reads?.verdicts.has(id);
  const verdicts = ahead ? reads.verdicts.get(id) : verdictRows(board, id);
  const receipts = ahead ? reads.receipts.get(id) : board.db.prepare("SELECT event_id, event_kind, event_detail FROM event WHERE item_id = ? AND event_kind IN ('accept', 'reject') ORDER BY event_id").all(id);
  const withdrawals = verdictWithdrawals(board, id, verdicts.map((verdict, index) => ({ verdict, event: receipts[index] })), ahead ? reads.reopens.get(id) : undefined);
  return verdicts.map((verdict, index) => {
    let detail = {};
    try { detail = JSON.parse(receipts[index]?.event_detail ?? '{}'); } catch { /* Malformed legacy details remain unknown. */ }
    return { ...verdict, ...(withdrawals.has(verdict.verdict_id) ? { withdrawn: true, withdrawal: withdrawals.get(verdict.verdict_id) } : {}), assurance: verdictAssurance(board, verdict), check: detail.check ?? 'unknown', ...(detail.review ? { review: detail.review } : {}), ...(detail.companionDigest ? { companionDigest: detail.companionDigest } : {}),
      ...(Object.hasOwn(detail, 'environment') ? { environment: detail.environment } : {}),
      ...(typeof detail.clause === 'string' && typeof detail.barKey === 'string' ? { clause: detail.clause, barKey: detail.barKey } : {}) };
  });
}

/** The latest matching acceptance; the submission stays immutable through later re-reviews. */
export function acceptedVerdict(board, item) {
  const verdicts = verdictsFor(board, item.item_id);
  const latest = verdicts.findLast(verdict =>
    verdict.verdict_decision === 'ACCEPT' && verdict.verdict_commit === item.item_commit);
  if (latest) return latest.withdrawn ? undefined : advancedVerdict(board, item, latest);
  if (item.item_status === 'verified') {
    const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`rehome_import:${item.item_id}`);
    if (row) {
      let imported;
      try { imported = JSON.parse(row.meta_value); } catch { imported = null; }
      const source = (imported?.sourceVerdicts ?? []).findLast(verdict => verdict.verdict_decision === 'ACCEPT'
        && verdict.verdict_commit === item.item_commit && verdict.verdict_digest === item.item_frozen_digest
        && verdict.verdict_by === item.item_verified_by && verdict.verdict_by !== item.item_built_by);
      if (source && imported.sourceStatus === 'verified' && imported.sourceMoveDigest === imported.sourceReceipt?.resultDigest
          && typeof imported.attestedBy === 'string' && imported.moveId) {
        return { ...source, verdict_id: `import:${imported.sourceBoardId}:${imported.moveId}:${source.verdict_id}`,
          assurance: 'imported', imported: { sourceBoardId: imported.sourceBoardId, sourceItemId: imported.sourceItemId,
            sourceHandle: imported.sourceHandle, moveId: imported.moveId, attestedBy: imported.attestedBy,
            sourceReceipt: imported.sourceReceipt } };
      }
    }
  }
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'merge-only-accept' AND json_extract(event_detail,'$.commit') = ? ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id, item.item_commit);
  if (!event) return undefined;
  const carry = JSON.parse(event.event_detail);
  const original = verdicts.find(verdict => verdict.verdict_id === carry.verdict && verdict.verdict_decision === 'ACCEPT'
    && verdict.verdict_digest === item.item_frozen_digest && verdict.verdict_by === carry.by);
  if (!original || original.withdrawn) return undefined;
  return advancedVerdict(board, item, { ...original, carried: carry, review: { commit: carry.commit, head: carry.commit,
    trunk: carry.trunk, paths: carry.paths } });
}

/** The exact checked composition for a new acceptance, or the historical submitted candidate. */
export function checkedLandingCommit(board, item) {
  const accepted = acceptedVerdict(board, item);
  const patches = itemPatchDigest(board, item.item_id);
  if (item.item_status === 'verified' && patches && accepted?.companionDigest !== patches) {
    throw new Refused('ITEM_PATCH_CHANGED', 'the accepted patch set changed; review the current composition before landing');
  }
  return accepted?.review?.head ?? item.item_commit;
}

/** Old verdicts without an assurance record never acquire independent status from later seat enrollment. */
export function verdictAssurance(board, verdict) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?')
    .get(`verdict_assurance:${verdict.verdict_id}`)?.meta_value === 'independent' ? 'independent' : 'procedural';
}
