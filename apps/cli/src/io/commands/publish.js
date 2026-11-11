import { checkAtCommit } from '../../../../runner/index.js';
/** The pullboard publish command, in its own module so an item adding another command never edits these lines. */
import { publishTrunk } from '../../../../../packages/github/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  observer as flakeObserver,
} from '../../../../../packages/flakes/index.js';
import {
  actOn,
  ordered,
  resourceAgent,
  withBoard,
} from '../entry.js';

/** Run `pullboard publish` and return its exit code. */
export async function run(io, { first, second, rest }) {
  return actOn(io, async (ctx, board, me) => {
    if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator publishes the trunk; ask your coordinator to run pullboard publish');
    if (first || second || rest.length) throw new Refused('USAGE', 'pullboard publish');
    const config = mainPolicy(ctx.info.root).config;
    const onFailure = flakeObserver(ctx, { kind: 'land', board, config }, { ordered, withBoard, resourceAgent, checkAtCommit });
    const result = await publishTrunk({ root: ctx.info.root, board, config, say: io.say, onWait: io.gateWaitReporter(io), onFailure,
      write: (operation, args) => ordered(ctx, board, operation, args) });
    io.result?.(result);
    return result.published || result.waiting ? 0 : 1;
  });
}
