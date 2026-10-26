/** The pullboard lanes command, in its own module so an item adding another command never edits these lines. */
import {
  COORDINATOR,
} from '../config.js';
import * as store from '../board.js';
import { Refused } from '../refused.js';
import { laneNames } from '../lanes.js';
import {
  actOn,
  context,
  ordered,
  withBoard,
} from '../cli.js';

/** Run `pullboard lanes` and return its exit code. */
export async function run(io, { first, second, rest }) {
  if (first !== undefined) {
    if (first !== 'lead' || !second || rest.length !== 1) throw new Refused('USAGE', 'use pullboard lanes lead <lane> <seat|off>');
    return actOn(io, async (ctx, board, me) => {
      const leads = await ordered(ctx, board, 'setLaneLead', [{ agentId: me.id, lane: second, seat: rest[0] === 'off' ? null : rest[0], lanes: laneNames(ctx.config) }]);
      io.result?.({ leads }); io.say(rest[0] === 'off' ? `removed lead for ${second}` : `${second} lead is ${rest[0]}`);
      return 0;
    });
  }
  const { config } = context(io);
  const leads = withBoard(context(io), board => store.laneLeads(board));
  io.result?.({ lanes: config.lanes, shared: config.shared, coordinator: COORDINATOR, leads });
  io.say(`${COORDINATOR.padEnd(14)} everything no lane owns; verifies, merges, may change any path`);
  for (const [name, lane] of Object.entries(config.lanes)) {
    const specs = lane.specs?.length ? `  [${lane.specs.join(', ')}]` : '';
    const starts = lane.starts ? `  starts: ${lane.starts}` : '';
    io.say(`${name.padEnd(14)} ${lane.owns.length ? lane.owns.join(' ') : '(owns no folders)'}${specs}${starts}`);
  }
  if (config.shared.length) io.say(`${'shared'.padEnd(14)} ${config.shared.join(' ')} (any lane)`);
  return 0;
}
