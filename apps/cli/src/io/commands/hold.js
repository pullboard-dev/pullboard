/** The pullboard hold command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { requireSignedPerson } from '../../../../../packages/person/index.js';
import { requirePersonChannel } from '../../../../../packages/person/index.js';
import {
  isLane,
} from '../../../../../packages/seats/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  actOn,
  idArg,
  ordered,
  personMode,
} from '../entry.js';

/** Run `pullboard hold` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values.off && values.until !== undefined) throw new Refused('USAGE', '--off and --until cannot be combined');
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
      await ordered(ctx, board, 'holdItem', [id, { agentId: me.id, reason, ...(values.until === undefined ? {} : { until: values.until }) }]);
      io.say(`holding #${id}: ${reason}. Lift it with: pullboard hold ${id} --off`);
    }
    io.result?.({ id, lane: store.getItem(board, id).item_lane, held: !values.off, reason: values.off ? null : reason });
    return 0;
  }
  if (values.until !== undefined) throw new Refused('USAGE', '--until applies to an item hold, not a lane hold');
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
