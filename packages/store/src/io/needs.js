/** An item's needs list is native metadata, just like its readiness command [U136,C7,#1888]. */
import { Refused } from '../../../kernel/index.js';
import { validateNeeds } from './board/query.js';
import { deleteBoardMeta } from './board/meta.js';
import { writeBoardMeta } from './board/meta.js';
import { readBoardMeta } from './board/meta.js';

/**
 * Require a list of need names the board knows; undefined leaves the needs alone and an empty list clears them.
 * Why: a misspelt need would never be met by any agent and would strand the item silently.
 */
export function validateItemNeeds(value) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(need => typeof need !== 'string')) throw new Refused('USAGE', 'needs are a list of names; use --needs browser,gui or "" to clear them');
  validateNeeds(value);
}

/** Persist only an explicitly authored list; an empty one removes it so the item reads [] again. */
export function saveItemNeeds(board, id, value) {
  if (value === undefined) return;
  const key = `item_needs:${id}`;
  if (value.length === 0) deleteBoardMeta(board.db, key);
  else writeBoardMeta(board.db, key, JSON.stringify([...new Set(value)]));
}

/**
 * Require a list of ability names the board knows, through the same check as an item's needs; undefined leaves a seat's abilities alone.
 * Why: a misspelt ability would never meet any item's need and would hide the seat's real worth silently.
 */
export function validateAgentAbilities(value) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(ability => typeof ability !== 'string')) throw new Refused('USAGE', 'abilities are a list of names, such as browser or gui');
  validateNeeds(value);
}

/** Persist the abilities a seat declared at join under agent_abilities:<agent_id>; an empty list removes them so the seat reads [] again. */
export function saveAgentAbilities(board, agentId, value) {
  if (value === undefined) return;
  const key = `agent_abilities:${agentId}`;
  if (value.length === 0) deleteBoardMeta(board.db, key);
  else writeBoardMeta(board.db, key, JSON.stringify([...new Set(value)]));
}

/** The abilities a seat declared at join, [] for a seat that never declared any. */
export function agentAbilities(board, agentId) {
  const stored = readBoardMeta(board.db, `agent_abilities:${agentId}`);
  return stored ? JSON.parse(stored) : [];
}
