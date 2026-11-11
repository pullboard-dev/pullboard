/** Derive current material authority solely from replicated native source records [V4,H16]. */
import { ENGINE_VERSION } from '../../../../state/index.js';
import { REVIEW_HEAD_BUILDER_FAMILY_ENGINE } from '../../../../state/light.js';
import { STRICT_COMPOSITION_ENGINE } from '../../../../state/light.js';
import { itemPatchAuthors } from '../../../../items/index.js';
import { itemPatches } from '../../../../items/index.js';
import { itemReviewPolicy } from '../../logic/review/policy.js';
import { familyName } from '../../logic/review/policy.js';
import { familyAliasesOf } from '../../logic/review/policy.js';
import { seatFamily } from '../../../../items/index.js';

/** Genuine historical moves retain their recorded exclusion rules. */
export function compositionReviews(board) {
  return (board.executionEngineVersion ?? ENGINE_VERSION) >= STRICT_COMPOSITION_ENGINE;
}

/** Strict review selects active patch snapshots; Standard and old ordered reviews retain their original history. */
export function reviewPatchAuthors(board, item) {
  return compositionReviews(board) && itemReviewPolicy(board, item.item_id).tier === 'strict'
    ? itemPatches(board, item.item_id).map(patch => patch.author) : itemPatchAuthors(board, item.item_id);
}

/** Current material contributors exclude superseded submissions and removed companions. */
export function compositionAuthors(board, item) {
  return [...new Set([item.item_built_by ?? item.item_owner, ...itemPatches(board, item.item_id).map(patch => patch.author.agentId)].filter(Boolean))];
}

/** Count actual added/deleted hunk lines, excluding file headers and context. */
function patchLines(patch) {
  if (typeof patch !== 'string') return null;
  let hunk = false, count = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) hunk = false;
    else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line)) hunk = true;
    else if (hunk && (line.startsWith('+') || line.startsWith('-'))) count++;
  }
  return count;
}

/** Pick the unique largest measured contributor; ties or missing legacy evidence retain the last builder. */
export function compositionOwner(board, item) {
  const builder = item.item_built_by ?? item.item_owner;
  if (!builder) return null;
  const submission = board.db.prepare("SELECT event_by,event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC").all(item.item_id)
    .find(event => event.event_by === builder && JSON.parse(event.event_detail).commit === item.item_commit);
  const size = submission && JSON.parse(submission.event_detail).submissionSize;
  if (!size || size.head !== item.item_commit || size.method !== 'added-plus-deleted-no-renames' || !Number.isSafeInteger(size.lines) || size.lines < 0) return builder;
  const counts = new Map([[builder, size.lines]]);
  for (const patch of itemPatches(board, item.item_id)) {
    const lines = patchLines(patch.patch);
    if (lines === null) return builder;
    counts.set(patch.author.agentId, (counts.get(patch.author.agentId) ?? 0) + lines);
  }
  const largest = Math.max(...counts.values());
  const owners = [...counts].filter(([, lines]) => lines === largest);
  return owners.length === 1 ? owners[0][0] : builder;
}

/**
 * Relax only vendor-family comparisons when material contributors span all joined declared families.
 * From the head-builder-family engine on there is nothing to relax: only the submitted head builder's family is judged.
 */
export function compositionFamilyFallback(board, item) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_HEAD_BUILDER_FAMILY_ENGINE) return null;
  if (!compositionReviews(board) || itemReviewPolicy(board, item.item_id).tier !== 'strict') return null;
  const aliases = familyAliasesOf(board);
  const canonical = id => familyName(id === item.item_built_by ? item.item_builder_family ?? seatFamily(board, id) : seatFamily(board, id), aliases);
  const authors = compositionAuthors(board, item);
  const authorFamilies = authors.map(canonical);
  if (authorFamilies.some(family => !family)) return null;
  const families = new Set(authorFamilies);
  if (families.size < 2) return null;
  const joined = board.db.prepare('SELECT agent_id FROM agent ORDER BY agent_id').all().map(seat => canonical(seat.agent_id)).filter(Boolean);
  if (joined.some(family => !families.has(family))) return null;
  const owner = compositionOwner(board, item);
  return { owner, family: canonical(owner) };
}

/** Current strict local checks use immutable native author session snapshots, never superseded local ledger rows. */
export function compositionSessionOptions(board, item) {
  if (!compositionReviews(board) || itemReviewPolicy(board, item.item_id).tier !== 'strict') return {};
  const sessions = compositionAuthors(board, item).map(id => board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${id}`)?.meta_value);
  // Missing legacy identity cannot erase a local ledger exclusion. Native sessions are write-once.
  if (sessions.some(value => typeof value !== 'string' || !value)) return {};
  sessions.push(...itemPatches(board, item.item_id).map(patch => patch.author.session));
  return { currentAuthorSessions: sessions.filter(value => typeof value === 'string' && value) };
}
