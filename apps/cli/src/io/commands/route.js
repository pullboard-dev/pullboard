/** The pullboard route command: `route --suggest` lists the open strong items whose shape meets the light rule, read-only [C7,#3081]; `route <id> --to <seat>` and `route <id> --off` record and clear a reservation behind route.reservations [C7,#9160]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { shapeRoute } from '../../../../../packages/items/index.js';
import * as store from '../../../../../packages/store/light.js';
import { routeReservations } from '../../../../../packages/config/index.js';
import {
  actOn,
  context,
  idArg,
  ordered,
} from '../entry.js';
import { withBoardRead } from '../board/read.js';

/** Query-only dispatch for --suggest; --to and --off write through actOn, which opens the board itself. */
export const nativeBoardRequired = false;

/**
 * Run `pullboard route --suggest` and return its exit code.
 * Why read-only: the shape rule is advice (the same function `add` uses), so a person or coordinator decides whether to
 * `pullboard edit <id> --route light`; the command never edits an item [C7,#3081].
 */
export async function run(io, { first, values = {} }) {
  if (first !== undefined && !values.suggest && (values.to !== undefined || values.off)) return reserve(io, first, values);
  if (first !== undefined || !values.suggest) throw new Refused('USAGE', 'route needs --suggest, or an item id with --to <seat> or --off', 'pullboard route --suggest');
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

/**
 * Record or clear one item's reservation through the reserveItem and clearReservation moves.
 * Why refused when off: the setting gates the whole feature, so with it off the command names it instead of writing [C7,#9160].
 */
async function reserve(io, first, values) {
  if (values.to !== undefined && values.off) throw new Refused('USAGE', 'route takes --to <seat> or --off, not both', 'pullboard route <id> --to <seat>');
  if (!routeReservations()) throw new Refused('SETTING_OFF', 'route reservations are off', 'turn on route.reservations in the machine settings first');
  const id = idArg(first);
  // The command opts out of the native board for --suggest, so a write loads it here the way the dispatcher does for other commands.
  await io.prepareProcessPorts();
  io.nativeBoard ??= await io.loadNativeBoard();
  return actOn(io, async (ctx, board, me) => {
    if (values.off) {
      await ordered(ctx, board, 'clearReservation', [id, { agentId: me.id }]);
      io.say(`cleared the reservation on #${id}`);
      io.result?.({ id, reserved: false });
    } else {
      await ordered(ctx, board, 'reserveItem', [id, { agentId: me.id, holder: String(values.to) }]);
      io.say(`reserved #${id} for ${values.to}. Clear it with: pullboard route ${id} --off`);
      io.result?.({ id, reserved: true, holder: String(values.to) });
    }
    return 0;
  });
}
