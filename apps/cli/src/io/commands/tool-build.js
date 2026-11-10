/** Explicit coordinator promotion is separate from the hourly command-boundary refresh. */
import { actOn } from '../entry.js';
import { context } from '../entry.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { gatedToolBuild } from '../pinned/tool/publish.js';
import {
  toolBuildLocation,
  readToolBuild,
  writeToolBuild,
} from '../pinned/tool/build.js';

/** Read the board's pin, or promote a real gated commit from the primary coordinator checkout. */
export async function run(io, { first, second, values }) {
  if (values.watch) {
    if (first || second || !values.key) throw new Refused('USAGE', 'the tool build timer needs its registered key');
    const ctx = context(io);
    if (!ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'the tool build timer runs on the primary checkout');
    const result = await (await import('../tool/build.js')).runScheduledToolBuildGate(ctx, values.key);
    return result.code ?? 0;
  }
  if (values.key !== undefined) throw new Refused('USAGE', '--key belongs to the registered tool build timer');
  return actOn(io, (ctx, _board, me) => {
    const location = toolBuildLocation(ctx.info.root);
    if (!first) { const build = readToolBuild(location); io.result?.({ build }); io.say(build ? `tool build ${build.commit} since ${build.promotedAt}` : 'tool build: not published'); return 0; }
    if (first !== 'promote' || !second || !values['gate-receipt']) throw new Refused('USAGE', 'pullboard tool-build promote <commit> --gate-receipt <native-full-gate-id>');
    if (me.id !== 'coordinator' || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the primary coordinator promotes the board tool build');
    const build = writeToolBuild(location, gatedToolBuild(location, second, values['gate-receipt']));
    io.result?.({ build }); io.say(`promoted tool build ${build.commit}; new commands use it`); return 0;
  });
}
