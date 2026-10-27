/** The pullboard hold command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import { requireSignedPerson } from '../person-signing-cli.js';
import { requirePersonChannel } from '../person.js';
import {
  isLane,
} from '../lanes.js';
import {
  Refused,
} from '../refused.js';
import {
  actOn,
  idArg,
  ordered,
  personMode,
} from '../cli.js';

/** Run `pullboard hold` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values.off && values.until !== undefined) throw new Refused('USAGE', '--off and --until cannot be combined');
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const itemTarget = /^#?\d+$/u.test(first ?? '');
  if (itemTarget) {
    const id = idArg(first);
    const reason = values.reason ?? [second, ...rest].filter(Boolean).join(' ');
    if (values.off) {
      await ordered(ctx, board, 'releaseItemHold', [id, { agentId: me.id }]);
      io.say(`lifted the hold on #${id}`);
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
}
