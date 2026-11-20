/** The pullboard hold command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { requireSignedPerson } from '../../../../../packages/person/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import { holdsRequireOwner } from '../../../../../packages/config/index.js';
import {
  isLane,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  actOn,
  idArg,
  context,
  ordered,
  personMode,
  withBoardRead,
} from '../entry.js';

/** `pullboard hold --list --owner <value>`: one line per open held item recorded with that owner, oldest deadline first; a plain read, nothing is written. */
function listHolds(io, { first, second, rest, values }) {
  if (first || second || rest.length || values.off || values.until !== undefined || values.deadline !== undefined) {
    throw new Refused('USAGE', 'pullboard hold --list [--owner <seat|lane|person>] takes no item and no other option');
  }
  const holds = withBoardRead(context(io), (board) => store.listItems(board).filter((item) => item.item_hold_reason)
    .flatMap((item) => { const record = store.itemHoldOwner(board, item.item_id); return record && (values.owner === undefined || record.owner === values.owner) ? [{ id: item.item_id, deadline: record.deadline, reason: item.item_hold_reason }] : []; }))
    .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline) || a.id - b.id);
  io.result?.({ owner: values.owner, holds });
  if (!holds.length) io.say(`no ${values.owner ?? 'owned'} holds`);
  for (const hold of holds) io.say(`#${hold.id} ${hold.deadline} ${String(hold.reason).split('\n')[0]}`);
  return 0;
}

/** Run `pullboard hold` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values.off && (values.until !== undefined || values.owner !== undefined || values.deadline !== undefined)) throw new Refused('USAGE', '--off cannot be combined with --until, --owner or --deadline');
  if (values.list) return listHolds(io, { first, second, rest, values });
  let released = null;
  const code = await actOn(io, async (ctx, board, me) => {
  const itemTarget = /^#?\d+$/u.test(first ?? '');
  if (itemTarget) {
    const id = idArg(first);
    const reason = values.reason ?? [second, ...rest].filter(Boolean).join(' ');
    if (values.off) {
      await ordered(ctx, board, 'releaseItemHold', [id, { agentId: me.id }]);
      io.say(`lifted the hold on #${id}`);
      if (store.getItem(board, id).item_status === 'verified') released = ctx;
    } else {
      // The setting rides in the move, so every replica applies the rule this hold was made under [C7,#8540].
      await ordered(ctx, board, 'holdItem', [id, { agentId: me.id, reason, ...(values.until === undefined ? {} : { until: values.until }),
        ...(values.owner === undefined ? {} : { owner: values.owner }), ...(values.deadline === undefined ? {} : { deadline: values.deadline }),
        ...(holdsRequireOwner() ? { requireOwner: true } : {}) }]);
      const owned = store.itemHoldOwner(board, id);
      io.say(`holding #${id}: ${reason}${owned ? ` (owner ${owned.owner}, deadline ${owned.deadline})` : ''}. Lift it with: pullboard hold ${id} --off`);
    }
    io.result?.({ id, lane: store.getItem(board, id).item_lane, held: !values.off, reason: values.off ? null : reason,
      ...(!values.off && store.itemHoldOwner(board, id) ? { ...store.itemHoldOwner(board, id), heldAt: store.getItem(board, id).item_hold_at } : {}) });
    return 0;
  }
  if (values.until !== undefined || values.owner !== undefined || values.deadline !== undefined) throw new Refused('USAGE', '--until, --owner and --deadline apply to an item hold, not a lane hold');
  if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
  const asPerson = io.personChannel === 'view' || values.as === 'person' && personMode(ctx, me, values);
  if (asPerson) {
    const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'hold', args: { lane: first,
      ...(values.off ? { off: true } : { reason: String(values.reason ?? '') }) } });
    if (confirmed !== null) return confirmed;
    requirePersonChannel(io.personChannel);
  }
  if (values.off) {
    await ordered(ctx, board, 'releaseLane', [first, { agentId: me.id, asPerson, channel: io.personChannel ?? 'terminal' }]);
    io.say(`released the ${first} lane`);
  } else {
    await ordered(ctx, board, 'holdLane', [first, { agentId: me.id, reason: values.reason ?? '', asPerson, channel: io.personChannel ?? 'terminal' }]);
    io.say(`holding the ${first} lane: ${values.reason}. Release it with: pullboard hold ${first} --off`);
  }
  io.result?.({ lane: first, held: !values.off, reason: values.off ? null : values.reason });
  return 0;
});
  // A released verified item can land now; wake landing the way an accept does, after the board lock is free [C7,#2898].
  if (released) await (await import('./land.js')).landAfterAcceptance(released);
  return code;
}
