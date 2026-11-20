/** Print an item's code map slice after a claim when the board's map.slice setting is on, else one line naming the command [1203]. */
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';
import { mainCheckout } from '../../../git/index.js';
import { codeMapHome } from './home.js';

const disk = fileSystemAdapter();

/**
 * Say the item's one-hop code map slice when `map.slice` is true in pullboard.json. Off by default, it says one
 * line naming `pullboard map --for <id>` and builds no map, so a builder finds the command without the slice costing every handout. The slice is read from the primary
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
  if (!item) return;
  if (ctx.config.map?.slice !== true) {
    io.say('code map: pullboard map --for ' + item.item_id);
    return;
  }
  const root = primaryCheckoutRoot(ctx.info);
  const trunk = root ? mainCheckout(root) : null;
  if (!root || trunk?.branch !== 'refs/heads/main' || !trunk.commit) {
    io.say('map slice skipped: no reachable primary main checkout; restore it, then run pullboard map --for ' + item.item_id);
    return;
  }
  const cacheFile = join(codeMapHome(ctx.info.commonDir), 'slice-cache', item.item_id + '.json');
  const stamp = createHash('sha256').update(JSON.stringify(item)).digest('hex');
  const cached = readCachedSlice(cacheFile, trunk.commit, stamp);
  if (cached !== null) {
    io.say(cached);
    return;
  }
  const { ensureCodeMap, renderItemSlice } = await import('./map.js');
  try {
    const map = ensureCodeMap(root, join(codeMapHome(ctx.info.commonDir), 'code-map.json'), trunk.commit);
    const text = renderItemSlice(map, item);
    writeCachedSlice(cacheFile, { commit: trunk.commit, stamp, text });
    io.say(text);
  } catch (error) {
    io.say('map slice skipped: ' + error.message);
  }
}

/** The rendered slice kept for this item at this main commit and item text, or null on any miss or unreadable file. */
function readCachedSlice(file, commit, stamp) {
  try {
    const entry = JSON.parse(disk.readFile(file, 'utf8'));
    return entry.commit === commit && entry.stamp === stamp && typeof entry.text === 'string' ? entry.text : null;
  } catch {
    return null;
  }
}

/** Keep only the newest slice for the item; a failed write only costs the next call a rebuild. */
function writeCachedSlice(file, entry) {
  try {
    disk.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    disk.writeFile(file, JSON.stringify(entry), { mode: 0o600 });
  } catch {
    // The cache is an optimization, never a reason to hide the slice.
  }
}
