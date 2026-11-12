/** Print an item's code map slice after a claim, only when the board's map.slice setting is on [1203]. */
import { join } from 'node:path';
import { mainCheckout } from '../../../git/index.js';

/**
 * Say the item's one-hop code map slice when `map.slice` is true in pullboard.json. Off by default,
 * so an agent's loop output is unchanged unless the board opts in. The slice is read from the primary
 * main checkout's cache, so every seat sees the same stamped source, and a missing or dirty main
 * prints one line naming the gap instead of guessing from a stale map.
 *
 * @param {{ say: (text: string) => void }} io
 * @param {{ config: any, info: any }} ctx
 * @param {{ item_id: number }|undefined} item - The claimed item, as the board stores it.
 * @param {(info: any) => string|null} primaryCheckoutRoot - The caller's resolver; passed in so this cell never imports the CLI.
 * @returns {Promise<void>}
 */
export async function sayMapSlice(io, ctx, item, primaryCheckoutRoot) {
  if (ctx.config.map?.slice !== true || !item) return;
  const root = primaryCheckoutRoot(ctx.info);
  const trunk = root ? mainCheckout(root) : null;
  if (!root || trunk?.branch !== 'refs/heads/main' || !trunk.commit) {
    io.say('map slice skipped: no reachable primary main checkout; restore it, then run pullboard map --for ' + item.item_id);
    return;
  }
  const { ensureCodeMap, renderItemSlice } = await import('./map.js');
  try {
    const map = ensureCodeMap(root, join(ctx.info.commonDir, 'pullboard', 'code-map.json'), trunk.commit);
    io.say(renderItemSlice(map, item));
  } catch (error) {
    io.say('map slice skipped: ' + error.message);
  }
}
