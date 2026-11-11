/**
 * An accepted item that conflicts with the trunk reopens for a main merge [B3,D1].
 *
 * When two accepted items touch the same lines, the second no longer merges onto the trunk. That
 * is not a failed test and not a reject: the work was accepted and only needs main merged into
 * it. `pullboard reopen <id> --conflict <file>` (once per file) records exactly that, naming the conflicting
 * files and the trunk commit they conflict with, and keeps the original accept on record. The
 * builder claims it with its bar unchanged, merges main and resubmits; the re-review checks the
 * frozen check at the new head and nothing else.
 */
import { Refused } from '../../../../kernel/index.js';
import { conflictNote } from '../../../../kernel/index.js';
import { shownPaths } from '../../../../kernel/index.js';
import { carriesConflict } from '../../logic/carriage.js';

export { carriesConflict };

/** The label an item carries from a conflict reopen until its next verdict. */
export const MAIN_MERGE_LABEL = 'needs main merge';

/**
 * The file paths `--conflict` names: one exact path per flag, in order, without repeats. Nothing is
 * split or trimmed inside a value, because a Git path may hold spaces, commas or any byte but NUL,
 * and it must match the path `git merge-tree -z` reports byte for byte.
 *
 * @param {string | string[] | undefined} values - one value per --conflict flag
 * @returns {string[]}
 */
export function conflictFiles(values) {
  return [...new Set([values ?? []].flat())];
}

/**
 * Check the trunk for the conflict the coordinator names, so --conflict cannot stand in for a
 * landing failure note on work that merges cleanly. Every named file must be one Git reports as
 * conflicting; the trunk commit comes from Git, never from the caller.
 *
 * @param {(commit: string) => { ref: string, commit: string, files: string[] | null }} trunkMerge - merges onto the trunk in memory
 * @param {string} commit - the accepted commit
 * @param {string[]} files - the files the coordinator names
 * @returns {{ files: string[], trunk: string }}
 */
export function requireTrunkConflict(trunkMerge, commit, files) {
  if (!files.length || files.some((file) => !file || file.includes('\0'))) throw new Refused('CONFLICT_FILES', 'name each file that conflicts with its own flag: pullboard reopen <id> --conflict <file> [--conflict <file>]');
  const merge = trunkMerge(commit);
  const branch = merge.ref.replace(/^refs\/heads\//u, '');
  if (!merge.files) throw new Refused('NOT_CONFLICTING', `${commit.slice(0, 12)} merges cleanly onto ${branch} at ${merge.commit.slice(0, 12)}; merge it, or reopen with --note "<test file>: <test name>; merge commit <sha>" after a red landing`);
  const unknown = files.filter((file) => !merge.files.includes(file));
  if (unknown.length) throw new Refused('CONFLICT_FILES', `${shownPaths(unknown)} ${unknown.length === 1 ? 'does' : 'do'} not conflict with ${branch} at ${merge.commit.slice(0, 12)}; the conflicting files are ${shownPaths(merge.files) || 'unnamed'}; name each with its own --conflict <file>`);
  return { files: [...new Set([...files, ...merge.files])], trunk: merge.commit };
}

/**
 * The conflict a coordinator's `--conflict` names, with the trunk commit Git reports. Anyone else,
 * or an item that is not accepted and unmerged, gets the files alone, so the board's own guards
 * refuse it in their declared order (COORDINATOR_ONLY, NOT_SUBMITTED, ALREADY_MERGED, NOT_ACCEPTED).
 *
 * @param {{ item: any, coordinator: boolean, values: string | string[] | undefined, trunkMerge: (commit: string) => { ref: string, commit: string, files: string[] | null } }} request
 * @returns {{ files: string[], trunk: string | null }}
 */
export function reopenConflict({ item, coordinator, values, trunkMerge }) {
  const files = conflictFiles(values);
  if (!coordinator || item.item_status !== 'verified' || item.item_merged_commit || !item.item_commit) return { files, trunk: null };
  return requireTrunkConflict(trunkMerge, item.item_commit, files);
}

/**
 * The refusal for a conflict reopen the board cannot record, or null. A conflict reopens only an
 * accepted item, and only under this engine; it names its files and a full trunk commit.
 *
 * @param {any} board
 * @param {any} item
 * @param {unknown} conflict
 * @param {(accept: number) => void} found - receives the id of the accept the reopen sets aside
 * @param {number} conflictEngine - the engine that introduced conflict reopens, passed in by the caller: the constant lives in
 *   the state cell, and merge importing state would close a cell cycle (state reaches merge through store) [R27]
 * @param {number} currentEngine - the engine a board without its own execution engine runs, passed in by the caller for the same reason
 * @param {number} submittedEngine - the engine that introduced the automatic return of a submitted conflict, passed in by the caller
 * @returns {Refused | null}
 */
export function conflictProblem(board, item, conflict, found, conflictEngine, currentEngine, submittedEngine) {
  const engine = board.executionEngineVersion ?? currentEngine;
  if (engine < conflictEngine) return new Refused('ENGINE_VERSION', `a reopen for a main merge requires engine ${conflictEngine}; this board uses engine ${engine}; upgrade Pullboard before using --conflict`);
  // A submitted head that no longer merges goes back to its builder before anyone reviews it (#807).
  // Only the automatic return names Git's trunk for a submission; a hand-written --conflict on one stays refused.
  const returning = item.item_status === 'submitted' && engine >= submittedEngine && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(conflict?.trunk ?? '');
  if (item.item_status !== 'verified' && !returning) return new Refused('NOT_ACCEPTED', `item #${item.item_id} is ${item.item_status}; --conflict reopens accepted work for a main merge, and a submission reopens with --note "why"`);
  const shape = /** @type {any} */ (conflict);
  const files = Array.isArray(shape?.files) ? shape.files : [];
  if (!files.length || files.some((file) => typeof file !== 'string' || !file || file.includes('\0')) || new Set(files).size !== files.length
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(shape?.trunk ?? '')) {
    return new Refused('BAD_CONFLICT', 'a trunk conflict names its files and the full trunk commit; run pullboard reopen <id> --conflict <file> from the main checkout');
  }
  if (returning) return null;
  const accept = board.db.prepare("SELECT event_id FROM event WHERE item_id = ? AND event_kind IN ('accept','merge-only-accept') AND json_extract(event_detail, '$.commit') = ? ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_commit);
  if (!accept) return new Refused('NOT_ACCEPTED', `item #${item.item_id} has no accept at ${String(item.item_commit).slice(0, 12)}; --conflict reopens accepted work for a main merge`);
  found(accept.event_id);
  return null;
}

/**
 * The cause key a trunk conflict records: the refusal Pullboard gives work that no longer merges.
 * Rigor (#713) reads cause keys and never counts a merge conflict, so a conflict reopen is never a
 * failing test, nor an uncaused reopen; two branches touching the same lines is no rule to learn.
 */
export const TRUNK_CONFLICT_CAUSE = 'refusal:MERGE_CONFLICT';

/**
 * The event fields a conflict reopen records: the conflict itself and its cause key.
 *
 * @param {{ files: string[], trunk: string }} conflict
 * @returns {{ conflict: { files: string[], trunk: string }, cause: string }}
 */
export function conflictDetail({ files, trunk }) {
  return { conflict: { files, trunk }, cause: TRUNK_CONFLICT_CAUSE };
}

/**
 * The trunk conflict an item still carries, or null: the newest reopen, accept or reject on it is
 * a conflict reopen. It names the accept it set aside, so the re-review knows what already passed.
 *
 * @param {any} board
 * @param {number} id
 * @returns {{ files: string[], trunk: string, commit: string, at: string, accept: { by: string, commit: string } | null, returned: boolean } | null}
 *   returned: a submission sent back before any review (#807), which sets no accept aside.
 */
export function mainMergeFor(board, id) {
  const last = board.db.prepare("SELECT event_detail, event_at FROM event WHERE item_id = ? AND event_kind IN ('reopen', 'accept', 'reject', 'merge-only-accept') ORDER BY event_id DESC LIMIT 1").get(id);
  const detail = last ? JSON.parse(last.event_detail) : null;
  if (!detail?.conflict) return null;
  const returned = !Number.isSafeInteger(detail.supersedes);
  const accept = returned ? null : board.db.prepare('SELECT event_by, event_detail FROM event WHERE event_id = ?').get(detail.supersedes);
  const accepted = accept ? JSON.parse(accept.event_detail) : null;
  return { ...detail.conflict, commit: detail.commit, at: last.event_at, returned,
    accept: accept ? { by: accepted.by ?? accept.event_by, commit: accepted.commit } : null };
}

/**
 * The lines `pullboard show` prints for an item that needs a main merge: what conflicts, then
 * what to do now, for the builder before resubmitting and for the reviewer after.
 *
 * @param {any} item
 * @param {NonNullable<ReturnType<typeof mainMergeFor>>} merge
 * @param {(id: string) => string} [name]
 * @returns {string[]}
 */
export function mainMergeLines(item, merge, name = (id) => id) {
  const accepted = merge.returned ? 'returned unreviewed' : merge.accept ? `accepted by ${name(merge.accept.by)} at ${merge.accept.commit.slice(0, 12)}` : 'accepted';
  const head = `${MAIN_MERGE_LABEL}: ${accepted}; conflicts with the trunk at ${merge.trunk.slice(0, 12)} in ${shownPaths(merge.files)}`;
  // A returned head was never reviewed, so its next review is a whole one.
  if (item.item_status === 'submitted' && merge.returned) return [head, `review: the whole criterion at ${item.item_commit.slice(0, 12)}; nothing was reviewed before it went back`];
  if (item.item_status === 'submitted') return [head, `re-review: main merge only; run the frozen check at ${item.item_commit.slice(0, 12)}; the accept above stands for the rest`];
  return [head, `next: pullboard claim ${item.item_id} (the bar is unchanged), merge main, resolve ${shownPaths(merge.files)}, commit, pullboard submit ${item.item_id}`];
}

/**
 * The items among `items` that still need a main merge, each with its conflict, for resume.
 *
 * @param {any} board
 * @param {any[]} items
 * @returns {{ item: any, merge: NonNullable<ReturnType<typeof mainMergeFor>> }[]}
 */
export function mainMergesFor(board, items) {
  return items.map((item) => ({ item, merge: mainMergeFor(board, item.item_id) })).filter(({ merge }) => merge);
}

/**
 * The line `pullboard reopen` prints: for a main merge, after a landing failure, or without a verdict.
 *
 * @param {string} id
 * @param {{ commit: string, conflict?: { files: string[], trunk: string }, landingFailure?: object }} result
 * @returns {string}
 */
export function reopenedLine(id, result) {
  if (result.withdrawnVerdict) return `reopened #${id} after verdict withdrawal; the earlier accept stays in history marked withdrawn`;
  if (result.conflict) return `reopened #${id} for a main merge: conflicts with the trunk at ${result.conflict.trunk.slice(0, 12)} in ${shownPaths(result.conflict.files)}; the accept at ${result.commit.slice(0, 12)} stays recorded`;
  return result.landingFailure
    ? `reopened #${id} after landing failure; previous accept remains recorded at ${result.commit.slice(0, 12)}`
    : `reopened #${id} without a verdict; previous commit ${result.commit.slice(0, 12)} remains recorded`;
}

/**
 * What the builder of a returned submission is told (#807): its head no longer merges onto the trunk, the files
 * that conflict, and the one step back: claim it, merge main and submit again.
 *
 * @param {number} id
 * @param {string} commit - the submitted head
 * @param {{ files: string[], trunk: string }} conflict
 * @returns {string}
 */
export function returnedHeadNotice(id, commit, conflict) {
  return `#${id} went back to you unreviewed: ${String(commit).slice(0, 12)} no longer merges onto the trunk at ${conflict.trunk.slice(0, 12)} (${shownPaths(conflict.files)}). Claim it, merge main, resolve ${conflict.files.length === 1 ? 'that file' : 'those files'} and submit again: pullboard claim ${id}`;
}
