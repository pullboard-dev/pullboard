/** Immutable acceptance provenance for a narrowly proved trunk merge [V1,V4,H16]. */
import { createHash } from 'node:crypto';
import { captureMergeOnly } from './merge-only-source.js';
import { Refused } from './refused.js';
import { acceptedVerdict } from './verdict-reviews.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Find only the latest conflict return and the exact unwithdrawn verdict it superseded. */
export function mergeOnlyBasis(board, item, { before = Number.MAX_SAFE_INTEGER } = {}) {
  const last = board.db.prepare("SELECT event_id, event_kind, event_detail FROM event WHERE item_id = ? AND event_id < ? AND event_kind IN ('reopen','accept','reject','refreeze','merge-only-accept') ORDER BY event_id DESC LIMIT 1").get(item.item_id, before);
  if (last?.event_kind !== 'reopen') return null;
  const returned = JSON.parse(last.event_detail);
  if ((!returned.conflict && !returned.landingFailure) || !Number.isSafeInteger(returned.supersedes)) return null;
  const accepted = board.db.prepare("SELECT event_detail FROM event WHERE event_id = ? AND item_id = ? AND event_kind IN ('accept','merge-only-accept')").get(returned.supersedes, item.item_id);
  if (!accepted) return null;
  const detail = JSON.parse(accepted.event_detail);
  const verdict = acceptedVerdict(board, { ...item, item_commit: returned.commit });
  if (!verdict || verdict.verdict_digest !== item.item_frozen_digest || detail.commit !== returned.commit || item.item_commit !== returned.commit) return null;
  return { acceptedCommit: returned.commit, acceptedHead: verdict.review?.head ?? returned.commit,
    digest: item.item_frozen_digest, verdict: verdict.verdict_id, by: verdict.verdict_by,
    reopen: last.event_id, conflict: returned.conflict ?? { trunk: null, files: [] },
    cleanOnly: !returned.conflict, review: verdict.review ?? null };
}

/** Validate sealed source facts against native history without consulting replica-local Git. */
export function mergeOnlyProblem(board, item, proof, { commit, tree, policyCommit }) {
  const basis = mergeOnlyBasis(board, item);
  const valid = basis && proof && proof.version === 1 && proof.reopen === basis.reopen
    && proof.verdict === basis.verdict && proof.acceptedCommit === basis.acceptedCommit
    && proof.acceptedHead === basis.acceptedHead && proof.digest === basis.digest
    && proof.commit === commit && proof.tree === tree && proof.trunk === policyCommit
    && ['acceptedCommit','acceptedHead','acceptedTree','commit','tree','trunk','mergeTree'].every(key => SHA.test(proof[key] ?? ''))
    && Array.isArray(proof.paths) && proof.paths.every(path => typeof path === 'string' && path && !path.includes('\0'))
    && JSON.stringify(proof.paths) === JSON.stringify([...new Set(proof.paths)].sort())
    && typeof proof.resolutionDiff === 'string' && proof.resolutionDiff.length <= 1024 * 1024
    && proof.resolutionHash === createHash('sha256').update(proof.resolutionDiff).digest('hex');
  return valid ? null : new Refused('MERGE_ONLY_PROOF', 'the carried acceptance must name the current conflict return, immutable verdict, unchanged frozen bar and exact gated merge; submit normally for outside review');
}

/** Prove the entire retained acceptance chain from immutable Git within one shared deadline. */
export function mergeOnlySourceValid(root, board, item, { seen = new Set(), deadline = Date.now() + 10000 } = {}) {
  const accepted = acceptedVerdict(board, item);
  if (!accepted?.carried) return true;
  const proof = accepted.carried;
  if (seen.has(item.item_commit) || seen.size >= 32 || Date.now() >= deadline) {
    return false;
  }
  seen.add(item.item_commit);
  const inherited = mergeOnlySourceValid(root, board, { ...item, item_commit: proof.acceptedCommit,
    item_tree: proof.acceptedTree, item_merged_commit: null }, { seen, deadline });
  if (!inherited) return false;
  const event = board.db.prepare("SELECT event_id FROM event WHERE item_id = ? AND event_kind = 'merge-only-accept' AND json_extract(event_detail,'$.commit') = ? ORDER BY event_id DESC LIMIT 1")
    .get(item.item_id, item.item_commit);
  const basis = event && mergeOnlyBasis(board, { ...item, item_commit: proof.acceptedCommit }, { before: event.event_id });
  const actual = basis && basis.by === proof.by && proof.digest === item.item_frozen_digest
    ? captureMergeOnly(root, basis, { commit: item.item_commit, tree: item.item_tree, trunk: proof.trunk, deadline }) : null;
  return Boolean(actual && Object.entries(actual).every(([key, value]) => JSON.stringify(value) === JSON.stringify(proof[key])));
}

/** Convert an invalid local source proof to the landing-only refusal; submit simply needs ordinary review. */
export function mergeOnlyLandingProblem(root, board, item) {
  return mergeOnlySourceValid(root, board, item) ? null
    : new Refused('STALE_VERDICT', `item #${item.item_id}: the recorded merge-only acceptance does not match real Git heads, trees and resolution diff; obtain an ordinary outside review before landing`);
}
