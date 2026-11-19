/** The likely-duplicate guard of pullboard add: a new item close to an open one is refused unless the filer says why it differs [C7]. */
import { itemText } from '../../../../../packages/search/index.js';
import { nearestOpenItems } from '../../../../../packages/search/index.js';
import { searchSidecarPath } from '../../../../../packages/search/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';

/** The similarity at or above which an open item counts as a likely duplicate of the one being filed. */
export const DUPLICATE_SCORE = 0.8;

/** The variable a fixture box sets so its numbered, near-identical fixture titles are not refused; the fixture environment strips every PULLBOARD_ variable otherwise, so a real board never sets it [C7]. */
export const FIXTURE_DISTINCT_ENV = 'PULLBOARD_FIXTURE_ADD_DISTINCT';

/**
 * Refuse a new item that likely duplicates an open one, unless `--not-duplicate-of "<id> <why>"` names it and says why it differs.
 * Why: a cause filed once per occurrence floods the board; the nearest open items hold the evidence instead. A broken or
 * missing search index never blocks filing, since this is a guard on advice, not on the move.
 *
 * @param {object} ctx - The command context.
 * @param {object} board - The open board.
 * @param {object} item - The item about to be filed.
 * @param {string | undefined} given - The `--not-duplicate-of` value: an item id, then the reason.
 * @returns {{ id: number, reason: string } | null} The recorded answer, or null when none was given.
 */
export function guardDuplicate(ctx, board, item, given) {
  let answer = null;
  if (given !== undefined) {
    const parsed = /^#?(\d+)\s+(\S[\s\S]*)$/u.exec(String(given).trim());
    if (!parsed) throw new Refused('NOT_DUPLICATE_REASON', '--not-duplicate-of needs an item id and the reason it differs', 'use --not-duplicate-of "<id> why this item differs"');
    answer = { id: Number(parsed[1]), reason: parsed[2].trim() };
  }
  if (answer === null && environmentAdapter().get(FIXTURE_DISTINCT_ENV) === '1') return null;
  let near;
  try {
    near = nearestOpenItems(board, itemText(item), { sidecar: searchSidecarPath(ctx.info.root, ctx.info.commonDir), limit: 3 }).filter(row => row.score >= DUPLICATE_SCORE);
  } catch { return answer; }
  if (!near.length || answer) return answer;
  const named = near.map(row => `#${row.id} "${row.title}" (${row.score.toFixed(2)})`).join('; ');
  throw new Refused('DUPLICATE_LIKELY', `this item reads like an open one: ${named}`,
    `attach your evidence to #${near[0].id}, or file it with --not-duplicate-of "${near[0].id} why this item differs"`);
}
