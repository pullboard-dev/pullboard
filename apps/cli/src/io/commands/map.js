/** The local static code map command, kept lazy so ordinary reads do not build or load its scanner. */
import {
  join,
} from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { withBoardRead } from '../board/read.js';
import {
  context,
  idArg,
  primaryCheckoutRoot,
} from '../entry.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Print the current source overview, a module/function card, or an item's one-hop slice. */
export async function run(io, { first, values }) {
  if (values.for !== undefined && first !== undefined) {
    throw new Refused('USAGE', 'use either pullboard map <module or function> or pullboard map --for <item>');
  }
  if (values.budget !== undefined && values.for === undefined) {
    throw new Refused('USAGE', 'use --budget only with pullboard map --for <item>');
  }
  const ctx = context(io);
  const root = primaryCheckoutRoot(ctx.info);
  const trunk = root ? mainCheckout(root) : null;
  if (!root || trunk?.branch !== 'refs/heads/main' || !trunk.commit) {
    throw new Refused('NO_TRUNK', 'pullboard map needs a reachable primary main checkout; restore it, then retry');
  }
  const { ensureCodeMap, renderCodeMapOverview, renderMapCard, renderItemSlice } = await import('../../../../../packages/codemap/index.js');
  const cache = join(ctx.info.commonDir, 'pullboard', 'code-map.json');
  let map;
  try {
    map = ensureCodeMap(root, cache, trunk.commit);
  } catch (error) {
    throw new Refused('NO_TRUNK', 'pullboard map could not read a clean main source at '
      + trunk.commit.slice(0, 12) + ': ' + error.message + '; restore main/src and bin, then retry');
  }
  /** Keep every map view's JSON envelope explicit while preserving its ordinary text exactly. */
  function printMap(text) {
    io.result?.({ main: map.mainCommit, map: text });
    io.say(text);
  }
  if (values.for !== undefined) {
    const id = idArg(values.for, 'an item id after --for');
    const item = await withBoardRead(ctx, board => store.getItem(board, id));
    const budget = values.budget === undefined ? 4000 : Number(values.budget);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8000) {
      throw new Refused('USAGE', '--budget for an item slice must be a whole number from 1 to 8000 tokens');
    }
    try {
      printMap(renderItemSlice(map, item, { budget }));
    } catch (error) {
      if (error instanceof RangeError && error.message.startsWith('item slice budget too small')) {
        throw new Refused('USAGE', error.message);
      }
      throw error;
    }
    return 0;
  }
  if (first !== undefined) {
    const card = renderMapCard(map, first);
    if (card === null) throw new Refused('USAGE', 'no module or unique function "' + first
      + '" appears in the current map; use pullboard map for the overview');
    printMap(card);
    return 0;
  }
  printMap(renderCodeMapOverview(map));
  return 0;
}
