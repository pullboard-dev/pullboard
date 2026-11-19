/** A block is a named set of items with a tier; this file only builds and checks the value [C7]. */
import { Refused } from '../../../kernel/index.js';

export const BLOCK_TIERS = ['light', 'mid', 'strong'];

/**
 * Build a block record, refusing USAGE when the name, the ids or the tier cannot make one.
 * @param {string} name what the block is called
 * @param {number[]} ids two or more distinct item ids
 * @param {string} tier light, mid or strong
 * @returns {{ name: string, ids: number[], tier: string }}
 */
export function newBlock(name, ids, tier) {
  if (typeof name !== 'string' || name.trim() === '') throw new Refused('USAGE', 'a block needs a name: pullboard block add <name> <id> <id> --tier <light|mid|strong>');
  if (!Array.isArray(ids) || ids.length < 2) throw new Refused('USAGE', 'a block names two or more items');
  if (new Set(ids).size !== ids.length) throw new Refused('USAGE', 'a block names each item once; an id is repeated');
  if (!BLOCK_TIERS.includes(tier)) throw new Refused('USAGE', 'a block tier is light, mid or strong, not ' + JSON.stringify(tier));
  return { name, ids: [...ids], tier };
}
