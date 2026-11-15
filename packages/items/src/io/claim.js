/** Validate per-item worktree identity against the registered seat and live claim, below the cli so items never import apps/cli [B5,C7]. */
import { readFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { gitPath } from '../../../git/light.js';
import { repoInfo } from '../../../git/light.js';
import { sameCommonDir } from '../../../git/light.js';
import { tryGit } from '../../../git/light.js';
import { Refused } from '../../../kernel/light.js';

/** The registered seat identity and routing attributes used by an item folder. */
function agentRow(board, id) {
  return board.db.prepare(`SELECT agent.agent_id, agent.agent_lane, agent.agent_path, agent.agent_route, model.meta_value AS agent_model
    FROM agent LEFT JOIN board_meta model ON model.meta_key='agent_model:' || agent.agent_id WHERE agent.agent_id = ?`).get(id);
}

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
    const agent = agentRow(board, marker.seat);
    const item = board.db.prepare('SELECT item_status, item_owner, item_built_by FROM item WHERE item_id=?').get(marker.item);
    // A submitted item's folder still belongs to the seat that built it, so the work a submit does after the handoff resolves the same seat.
    const ownFolder = item?.item_status === 'claimed' && item.item_owner === marker.seat || item?.item_status === 'submitted' && item.item_built_by === marker.seat;
    if (!agent || !ownFolder
      || root !== itemFolderPath(agent.agent_path, marker.item)
      || !sameCommonDir(repoInfo(root).commonDir, repoInfo(agent.agent_path).commonDir)
      || tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout !== `${agent.agent_lane}/item-${marker.item}`) return null;
    if (missing) writeItemMarker(root, marker.seat, marker.item);
    return { agent, item: marker.item };
  } catch { return null; }
}

/** Resolve a claimed item's validated worktree, falling back to its seat only when no item folder exists. */
export function claimedItemRoot(board, item) {
  const agent = agentRow(board, item.item_owner);
  if (!agent) return null;
  const path = itemFolderPath(agent.agent_path, item.item_id);
  try { lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return agent.agent_path; throw error; }
  const identity = itemFolderIdentity(board, path);
  if (identity?.agent.agent_id !== agent.agent_id || identity.item !== item.item_id) {
    throw new Refused('ITEM_PATCH_SOURCE', `item folder ${path} is not the claimed builder's verified worktree`);
  }
  const seatHead = tryGit(agent.agent_path, ['rev-parse', '--verify', 'HEAD']).stdout;
  const itemHead = tryGit(path, ['rev-parse', '--verify', 'HEAD']).stdout;
  if (!seatHead || !itemHead) throw new Refused('ITEM_PATCH_SOURCE', 'cannot read the builder checkout heads');
  if (seatHead !== itemHead) {
    if (tryGit(path, ['merge-base', '--is-ancestor', itemHead, seatHead]).status === 0) return agent.agent_path;
    if (tryGit(path, ['merge-base', '--is-ancestor', seatHead, itemHead]).status !== 0) {
      throw new Refused('ITEM_PATCH_SOURCE', 'the seat and item folder have diverged; reconcile their commits before attaching a companion');
    }
  }
  return path;
}
