/** Observe in-flight heads after a landing without changing any peer checkout [N2,B3]. */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { headCommit } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { sameCommonDir } from '../../../git/index.js';
import { mechanicalConflictFiles } from './mechanical.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/**
 * A claimed item's own folder beside its seat checkout, when it exists in this repository.
 * Why: the seat checkout may sit on another item's commit, whose conflicts are not the item's (#3820, #2457).
 *
 * @param {string} seatPath - The builder's registered seat checkout.
 * @param {number} id - Item id.
 * @param {string} common - The repository's common git directory.
 * @returns {string|null} The item folder, or null when it is absent or foreign.
 */
function itemFolderPath(seatPath, id, common) {
  const folder = join(dirname(seatPath), `${basename(seatPath)}-item-${id}`);
  try {
    if (fs.exists(folder) && sameCommonDir(repoInfo(folder).commonDir, common)) return folder;
  } catch { /* an unreadable folder falls back to the submitted source or the seat checkout */ }
  return null;
}

/** Compare each recorded submission or live registered builder HEAD with one immutable landed tip. */
export function mainMovedWarnings({ root, board, trunk }, reads) {
  if (typeof reads?.listAgents !== 'function' || typeof reads?.listItems !== 'function') {
    throw new TypeError('main-move warnings require explicit listAgents and listItems read ports');
  }
  const common = repoInfo(root).commonDir;
  const agents = new Map(reads.listAgents(board).map(agent => [agent.agent_id, agent]));
  const observations = new Map();
  const merges = new Map();
  const warnings = [];
  for (const item of reads.listItems(board, { all: true })) {
    if (item.item_merged_commit || !['claimed', 'submitted', 'verified'].includes(item.item_status)) continue;
    // A queued or running submission names the source the gate is proving, ahead of any newer folder head [B5,V4].
    const queued = reads.submitHandoff?.(board, item.item_id);
    const queuedHead = ['queued', 'running'].includes(queued?.state) ? queued.commit : null;
    let head = queuedHead ?? (item.item_status === 'verified' ? item.item_checked_commit ?? item.item_commit : item.item_commit);
    if (item.item_status === 'claimed' && !queuedHead) {
      const seatPath = agents.get(item.item_owner)?.agent_path;
      // A returned submission stays the item's source when its folder is gone; the seat checkout may sit on another item's commit.
      const folder = seatPath ? itemFolderPath(seatPath, item.item_id, common) : null;
      const path = folder ?? (head ? null : seatPath);
      if (path) {
        if (!observations.has(path)) {
          try { observations.set(path, sameCommonDir(repoInfo(path).commonDir, common) ? headCommit(path) : null); }
          catch { observations.set(path, null); }
        }
        head = observations.get(path);
      } else if (!head) { warnings.push({ item: item.item_id, unavailable: 'builder has no registered checkout' }); continue; }
    }
    if (!head) { warnings.push({ item: item.item_id, unavailable: 'source HEAD is unavailable' }); continue; }
    if (!merges.has(head)) merges.set(head, mechanicalConflictFiles(root, trunk, head));
    const files = merges.get(head);
    if (files === null) warnings.push({ item: item.item_id, head, unavailable: 'Git could not compute this merge' });
    else if (files.length) warnings.push({ item: item.item_id, head, trunk, files });
  }
  return warnings;
}

/** Deliver one bounded board warning per conflicting path; retries do not repeat an identical observation. */
export async function warnMainMoved({ root, board, trunk, write, say }, reads) {
  const warnings = mainMovedWarnings({ root, board, trunk }, reads);
  for (const warning of warnings) {
    if (warning.unavailable) { say(`#${warning.item}: main-move observation unavailable: ${warning.unavailable}; submit still checks the actual source`); continue; }
    for (const file of warning.files) {
      const prefix = `#${warning.item} main moved to ${trunk.slice(0, 12)}; ${warning.head.slice(0, 12)} conflicts in `;
      const next = '; git merge main in your worktree, resolve, commit and resubmit';
      const path = JSON.stringify(file);
      say(prefix + path + next);
      const width = 400 - prefix.length - next.length - 30;
      const pathDigest = createHash('sha1').update(path).digest('hex').slice(0, 12);
      const pieces = [''];
      for (const character of path) {
        if (pieces.at(-1).length + character.length > width) pieces.push('');
        pieces[pieces.length - 1] += character;
      }
      for (const [index, piece] of pieces.entries()) {
        // A long path's pieces carry a digest of the whole path, so two paths that share a piece are told apart [#3094].
        const part = pieces.length > 1 ? ` (${index + 1}/${pieces.length} ${pathDigest})` : '';
        const text = prefix + piece + part + next;
        // The text carries the trunk sha, which moves on every landing; one head and file is told once (#3094).
        const told = `${warning.head.slice(0, 12)} conflicts in ${piece}${part}${next}`;
        const exists = board.db.prepare('SELECT 1 FROM shout WHERE shout_to=? AND shout_from=? AND instr(shout_text, ?) > 0').get(`item:${warning.item}`, 'coordinator', told);
        if (!exists) await write('shout', [{ from: 'coordinator', to: `item:${warning.item}`, item: warning.item, text, lanes: [] }]);
      }
    }
  }
  return warnings;
}
