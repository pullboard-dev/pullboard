/** A submitted sprint item lands on a green screen at the trunk tip, where a steady item waits for its accept [V2,M1,#12176]. */
import { itemPace } from '../../../../store/index.js';
import { repoInfo } from '../../../../git/index.js';
import { trunkRevisionReader } from '../../../../git/index.js';

const SHA = /^[0-9a-f]{40}$/u;

/**
 * Whether a green screen receipt is stored for this item at its commit, merged onto `base`. Why the receipt's own fields:
 * the screen job's result step holds the item, commit, base and verdict, so the read needs no job key format.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item_id: number, item_commit: string }} item
 * @param {string} base
 * @returns {boolean}
 */
export function greenScreenAt(db, item, base) {
  const field = path => `json_extract(CASE WHEN json_valid(s.job_step_payload) THEN s.job_step_payload ELSE '{}' END, '${path}')`;
  return Boolean(db.prepare(`SELECT 1 FROM job j JOIN job_step s ON s.job_step_job = j.job_id AND s.job_step_name = 'result'
    WHERE j.job_kind = 'screen' AND ${field('$.result.item')} = ? AND ${field('$.result.commit')} = ? AND ${field('$.result.base')} = ? AND ${field('$.result.green')} = 1 LIMIT 1`)
    .get(item.item_id, item.item_commit, base));
}

/** The primary checkout's trunk tip, read from its ref files without spawning Git; null when it cannot be read. */
function trunkTip(root) {
  try { return trunkRevisionReader(repoInfo(root))() ?? null; } catch { return null; }
}

/**
 * Whether a submitted item lands as a verified one does: its frozen pace is sprint, it is not merged, and a green screen
 * covers its commit on `base` (the current trunk tip when none is named). Why: under sprint a green screen stands in for
 * the accept, but only on the trunk it was merged onto; a red screen or one on an older tip lands nothing.
 * The pace is read from the row the caller already loaded, so a steady or strict item makes no board read here.
 * @param {{ db: import('node:sqlite').DatabaseSync, gitRoot?: string }} board
 * @param {{ item_id: number, item_status: string, item_commit?: string | null, item_merged_commit?: string | null, item_frozen?: string | null } | null | undefined} item
 * @param {string | null} [base]
 * @returns {boolean}
 */
export function sprintLandable(board, item, base = null) {
  if (item?.item_status !== 'submitted' || item.item_merged_commit || itemPace(item) !== 'sprint' || !item.item_commit) return false;
  const on = base ?? (board.gitRoot ? trunkTip(board.gitRoot) : null);
  return SHA.test(on ?? '') && greenScreenAt(board.db, item, on);
}
