/** Public outside-source facts; never credentials, native actors or executable provider settings. */
import { Refused } from "../../../../kernel/browser.js";

/** Read replayable metadata for one item without inferring native lineage for its outside author. */
export function outsideSource(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`outside:${id}`);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Persist public facts inside the caller's ordered transaction. */
export function saveOutsideSource(board, id, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`outside:${id}`, JSON.stringify(value));
}

/** Require a person approval bound to the exact sensitive submission before any landing work. */
export function requireOutsideOwner(board, item) {
  const source = outsideSource(board, item.item_id);
  if (source?.sensitive && (source.ownerApproval?.by !== 'person' || source.ownerApproval.commit !== item.item_commit)) {
    throw new Refused('OUTSIDE_OWNER_APPROVAL', `outside item #${item.item_id} touches sensitive paths; the owner runs: pullboard intake approve ${item.item_id}`);
  }
}

/** A board-level accept cannot bypass the container receipt by directly calling verify. */
export function outsideSandboxProblem(board, item, receipt) {
  if (!outsideSource(board, item.item_id)) return null;
  if (!receipt || receipt.version !== 1 || receipt.provider !== 'docker' || receipt.commit !== item.item_commit || receipt.tree !== item.item_tree || receipt.digest !== item.item_frozen_digest ||
      !Array.isArray(receipt.runs) || receipt.runs.length !== 2 || receipt.runs.some(run => run.exitCode !== 0 || run.network !== 'none' || run.credentials !== false || run.home !== 'empty') ||
      !/^22\.13\./u.test(receipt.runs[0]?.environment?.node ?? '') || !/^24\./u.test(receipt.runs[1]?.environment?.node ?? '')) {
    return new Refused('OUTSIDE_SANDBOX_REQUIRED', 'verify this outside item in the configured container: pullboard verify ' + item.item_id + ' accept --sandbox --note "what you checked"');
  }
  return null;
}

/** Outside PR code is revised by its source author, never claimed or submitted as native build work. */
export function outsideBuildProblem(board, item) {
  return outsideSource(board, item.item_id)?.kind === 'pull-request'
    ? new Refused('OUTSIDE_NATIVE_BUILD', `outside item #${item.item_id} stays with its PR author; ask the coordinator to return it, then intake the author's new exact head`)
    : null;
}
