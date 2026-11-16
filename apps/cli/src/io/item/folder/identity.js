/** Validate per-item worktree identity against the registered seat and live claim [B5,C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { gitPath } from '../../../../../../packages/git/light.js';
import { ITEM_MARKER_FILE } from '../../../../../../packages/items/light.js';
import { itemFolderIdentity } from '../../../../../../packages/items/light.js';
export { itemFolderPath, writeItemMarker } from '../../../../../../packages/items/light.js';
export { itemFolderIdentity };
import { repoInfo } from '../../../../../../packages/git/light.js';
import { agentAt } from '../../../../../../packages/store/light.js';
import { Refused } from '../../../../../../packages/kernel/light.js';

/**
 * The seat acting from a checkout: the seat registered there, or the seat whose live-claim item folder it is.
 * Every board command run inside an item folder resolves the same seat as its checkout [B5].
 */
export function seatAt(board, root) {
  return agentAt(board, root) ?? itemFolderIdentity(board, root)?.agent;
}

/**
 * The seat's own checkout, so item folders open beside it even when a command runs inside one.
 * Reads the stored path alone: a full seat read derives the family from sessions and Git [B3].
 */
export function seatRoot(ctx, board, me) {
  return (board && board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(me.id)?.agent_path) ?? ctx.info.root;
}


/**
 * The seat checkout an item folder was made from, or null when `root` is not an item folder.
 * A folder counts when it carries the private seat marker, or sits beside a seat checkout under the `<seat>-item-<n>` name.
 * Why: join run inside one registers a stray seat there, and its removal later loses the folder's uncommitted work.
 * @param {string} root the worktree top level to test
 * @returns {{ seat: string|null }|null} the seat checkout when it can be named
 */
export function itemFolderSeat(root) {
  const match = /^(.*)-item-([1-9]\d*)$/u.exec(root);
  let marked = true;
  try { readFileSync(gitPath(root, ITEM_MARKER_FILE)); } catch { marked = false; }
  if (!marked && !(match && existsSync(match[1]))) return null;
  return { seat: match?.[1] ?? null };
}

/** Name the native renewal for a missing-marker hook without granting checkout authority. */
export function itemFolderRenewalRefusal(board, root) {
  try {
    try { readFileSync(gitPath(root, ITEM_MARKER_FILE)); return null; }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    const match = /^(.*)-item-([1-9]\d*)$/u.exec(root);
    if (!match) return null;
    const agent = board.db.prepare('SELECT agent_id, agent_path FROM agent WHERE agent_path=?').get(match[1]);
    const item = board.db.prepare('SELECT item_id FROM item WHERE item_id=?').get(Number(match[2]));
    if (!agent || !item || repoInfo(root).commonDir !== repoInfo(agent.agent_path).commonDir) return null;
    return new Refused('ITEM_MARKER_MISSING', `item folder #${item.item_id} has no seat marker; renew its claim from ${agent.agent_path}: pullboard claim ${item.item_id}`);
  } catch { return null; }
}
