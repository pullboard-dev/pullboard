/** A claimed item's holder can invite another seat to a bounded child [C7,B26]. */
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { isLane } from '../../../../../packages/seats/index.js';
import { relayCommandReceipt } from '../../../../../packages/link/index.js';
import { relayCommandReceiptReported } from '../../../../../packages/link/index.js';
import { actOn } from '../entry.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';

/** Bind the request to the exact current frozen parent bar. */
export async function run(io, { first, second, rest, values }) {
  return actOn(io, async (ctx, board, me) => {
    const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
    let result;
    if (recovered) {
      io.recordedMove = true;
      for (const event of recovered.events) io.onEvent?.(event);
      result = recovered.result;
    } else {
      const parentId = idArg(first);
      const parent = store.getItem(board, parentId);
      const lane = values.lane ?? parent.item_lane;
      if (!isLane(ctx.config, lane)) throw new Refused('NO_LANE', `no lane "${lane}"; see pullboard lanes`);
      const files = String(values.files ?? '').split(',').map(file => file.trim()).filter(Boolean);
      result = await ordered(ctx, board, 'createItemSlice', [{ agentId: me.id, parentId,
        parentDigest: parent.item_frozen_digest, title: [second, ...rest].filter(Boolean).join(' '), lane, files, check: values.check }]);
    }
    const item = store.getItem(board, result.item);
    io.result?.({ item });
    io.say(`created slice #${item.item_id} under #${item.item_parent_id}`);
    if (recovered) await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
    return 0;
  });
}
