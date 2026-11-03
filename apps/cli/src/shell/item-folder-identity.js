/** Validate per-item worktree identity against the registered seat and live claim [B5,C7]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { gitPath } from '../../../../packages/git/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { agentAt } from '../../../../packages/store/index.js';
import { agentById } from '../../../../packages/store/index.js';

/** A seat's item folders are siblings of its checkout, never inside its working tree. */
export function itemFolderPath(root, id) { return join(dirname(root), `${basename(root)}-item-${id}`); }

/** Marker is private to this worktree's Git metadata, never part of the project. */
export function writeItemMarker(path, seat, item) {
  writeFileSync(gitPath(path, 'pullboard-item.json'), JSON.stringify({ version: 1, seat, item }) + '\n', { mode: 0o600 });
}

/**
 * The seat and item a per-item folder belongs to, or null.
 * A missing marker is restored only for an exact pre-marker folder whose seat still holds the claim,
 * so folders opened before markers existed keep working without a renewal.
 */
export function itemFolderIdentity(board, root) {
  try {
    let marker;
    let missing = false;
    try { marker = JSON.parse(readFileSync(gitPath(root, 'pullboard-item.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') return null;
      const match = /^(.*)-item-([1-9]\d*)$/u.exec(root);
      if (!match) return null;
      const seat = board.db.prepare('SELECT agent_id FROM agent WHERE agent_path=?').get(match[1]);
      if (!seat) return null;
      marker = { version: 1, seat: seat.agent_id, item: Number(match[2]) };
      missing = true;
    }
    if (marker.version !== 1 || typeof marker.seat !== 'string' || !Number.isSafeInteger(marker.item)) return null;
    const agent = agentById(board, marker.seat);
    const item = board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id=?').get(marker.item);
    if (!agent || item?.item_status !== 'claimed' || item.item_owner !== marker.seat
      || root !== itemFolderPath(agent.agent_path, marker.item)
      || repoInfo(root).commonDir !== repoInfo(agent.agent_path).commonDir
      || tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout !== `${agent.agent_lane}/item-${marker.item}`) return null;
    if (missing) writeItemMarker(root, marker.seat, marker.item);
    return { agent, item: marker.item };
  } catch { return null; }
}

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
