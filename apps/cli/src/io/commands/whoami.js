import { boardId } from '../../../../../packages/store/index.js';
import { seatAddress } from '../../../../../packages/seats/index.js';
/** The pullboard whoami command, in its own module so an item adding another command never edits these lines. */
import {
  context,
  whoAmI,
  withBoard,
} from '../entry.js';

/** Run `pullboard whoami` and return its exit code. */
export function run(io) {
  const ctx = context(io);
  const me = withBoard(ctx, (board) => {
    const agent = whoAmI(ctx, board);
    return { ...agent, address: seatAddress(boardId(board), agent.id) };
  });
  io.result?.({ ...me, path: ctx.info.root });
  io.say(`${me.displayName} (${me.lane} lane${me.route === 'light' ? ', light route' : ''}) at ${ctx.info.root}\naddress ${me.address}`);
  return 0;
}
