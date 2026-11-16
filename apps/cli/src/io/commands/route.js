/** The pullboard route command: `route --suggest` lists the open strong items whose shape meets the light rule, read-only [C7,#3081]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { shapeRoute } from '../../../../../packages/items/index.js';
import * as store from '../../../../../packages/store/light.js';
import { context } from '../entry.js';
import { withBoardRead } from '../board/read.js';

/** Query-only dispatch: the command never writes the board. */
export const nativeBoardRequired = false;

/**
 * Run `pullboard route --suggest` and return its exit code.
 * Why read-only: the shape rule is advice (the same function `add` uses), so a person or coordinator decides whether to
 * `pullboard edit <id> --route light`; the command never edits an item [C7,#3081].
 */
export async function run(io, { first, values = {} }) {
  if (first !== undefined || !values.suggest) throw new Refused('USAGE', 'route needs --suggest', 'pullboard route --suggest');
  const ctx = context(io);
  const items = await withBoardRead(ctx, board => store.listItems(board, {})
    .filter(item => item.item_status === 'open' && item.item_route === 'strong'
      && shapeRoute({ criterion: item.item_criterion, check: item.item_check, brief: item.item_brief }) === 'light')
    .map(item => ({ id: item.item_id, lane: item.item_lane, title: item.item_title })));
  io.result?.({ suggest: 'light', items });
  if (!items.length) io.say('no open strong item meets the light shape');
  for (const item of items) io.say(`#${item.id}  ${item.lane}  ${item.title}`);
  return 0;
}
