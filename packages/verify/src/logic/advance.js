/** Read source advances without changing submitted source, immutable verdicts or companion inputs [V4,H16]. */
import { itemPatchDigest } from '../../../items/light.js';
import { Refused } from '../../../kernel/light.js';

/** Capture the native submission episode, including a repeated submit of the same source. */
export function sourceAdvanceEpisode(board, id) {
  return board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind IN ('submit','reopen','refreeze','reject') ORDER BY event_id DESC LIMIT 1").get(id)?.event_id ?? null;
}

/** Distinguish a released/reacquired review even if its owner fields later return to their old values. */
export function sourceAdvanceReviewEpisode(board, id) {
  return board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind IN ('reserve','release') ORDER BY event_id DESC LIMIT 1").get(id)?.event_id ?? null;
}

/** Read only a chain whose immutable submission, bar, patch set and episode still match. */
export function sourceAdvanceChain(board, item) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_source_advance:${item.item_id}`);
  if (!row) return [];
  let value;
  try { value = JSON.parse(row.meta_value); } catch { throw new Refused('SOURCE_ADVANCE_STATE', 'restore the ordered source-advance history before using its effective head'); }
  if (value?.version !== 1 || !Array.isArray(value.chain) || value.chain.length < 1 || value.chain.length > 32) {
    throw new Refused('SOURCE_ADVANCE_STATE', 'restore the bounded ordered source-advance history');
  }
  const last = value.chain.at(-1);
  if (last.submitted !== item.item_commit || last.bar !== item.item_frozen_digest
    || last.patchDigest !== itemPatchDigest(board, item.item_id)
    || last.episode !== sourceAdvanceEpisode(board, item.item_id)) return [];
  // A genuine later review supersedes this continuation with its own checked head.
  if (board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='accept' AND event_id>? LIMIT 1").get(item.item_id,last.eventId)) return [];
  return value.chain;
}

/** Return the actual checked source while leaving the submitted candidate immutable. */
export function effectiveItemHead(board, item) {
  return sourceAdvanceChain(board, item).at(-1)?.head ?? null;
}

/** Project a retained acceptance only through the exact original verdict and unchanged native inputs. */
export function advancedVerdict(board, item, verdict) {
  const chain = sourceAdvanceChain(board, item);
  if (!chain.length || !verdict || verdict.withdrawn || chain.at(-1).verdict !== verdict.verdict_id) return verdict;
  const last = chain.at(-1);
  return { ...verdict, sourceAdvance: { eventId: last.eventId, receiptIds: last.phases.map(phase => phase.receipt.id), head: last.head },
    review: { commit: item.item_commit, head: last.head, trunk: last.trunk, paths: last.paths } };
}

/** An old writer cannot ignore an already-recorded effective-head protocol; old receipts replay first. */
export function sourceAdvanceFloor(board, engine) {
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key GLOB 'item_source_advance:*' LIMIT 1").get() ? engine : 1;
}

/** A concurrent source advance cannot lend its newer head to a check that actually ran against the old head. */
export function requireSourceAdvanceReview(board, item, captured) {
  const current = effectiveItemHead(board, item);
  if (current !== (captured ?? null) && (current !== null || captured !== undefined)) {
    throw new Refused('SOURCE_ADVANCE_STALE', 'read the current effective source and rerun its exact frozen check before recording a verdict');
  }
}
