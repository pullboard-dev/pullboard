/** The pullboard hook command, in its own module so an item adding another command never edits these lines. */
import { itemFolderIdentity } from '../../../../../packages/items/light.js';
import { busyRefusal } from '../../../../../packages/store/light.js';
import { openBoardReadOnly } from '../../../../../packages/store/light.js';
import { readBoardSnapshot } from '../../../../../packages/store/light.js';
import { systemClock } from '../../../../../packages/store/light.js';
import * as store from '../../../../../packages/store/light.js';
import { withGitCommandMemo } from '../../../../../packages/git/light.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { rowDecisions } from '../../../../../packages/spec/light.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { hookReader } from '../hook/read.js';

/** The thin hook entry reads its clock from here, so only this module names the store [H24]. */
export { systemClock as hookClock };
const hookRead = hookReader({ openBoardReadOnly, boardBusyError: busyRefusal, readBoardSnapshot });
/** The id of the seat committing at `root`, its own checkout or one of its item folders; null when none is. */
export function hookSeatId(ctx, root) {
  return hookRead(ctx, (board) => (store.agentAt(board, root) ?? itemFolderIdentity(board, root)?.agent)?.agent_id) ?? null;
}

/** The runner, landing and flake graphs a push gate needs, loaded by the pre-push hook alone [C7,#3250]. */
async function loadPushGraphs() {
  const { runnerExecutionServices } = await import('../../../../../packages/runners/index.js');
  const { landingExecutionServices, waivedLandingProof: nativeWaivedLandingProof } = await import('../../../../../packages/landing/index.js');
  const { quarantineWaivers } = await import('../../../../../packages/flakes/index.js');
  return { runnerExecutionServices, landingExecutionServices, nativeWaivedLandingProof, quarantineWaivers };
}

/**
 * The hooks git runs. In a repo without pullboard.json they pass, so a stray hook never blocks. Each hook's checks live in
 * their own module, loaded by the hook that runs them, so a commit pays only its own module graph [C7,H24].
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
export async function hookCommand(io, { first, second }) {
  const info = repoInfo(io.cwd);
  let ctx;
  try {
    // The thin hook entry supplies a light context; the full CLI builds the ordinary one, loaded only then [H24].
    ctx = io.hookContext ? io.hookContext(io) : (await import('../entry.js')).context(io);
  } catch (error) {
    if (error instanceof Refused && error.code === 'NO_CONFIG') return 0;
    throw error;
  }
  let problems;
  if (first === 'pre-commit' || first === 'pre-merge-commit') problems = await (await import('../hook/pre-commit.js')).preCommitHook(io, ctx, info, first, hookRead, rowDecisions);
  else if (first === 'commit-msg') problems = await (await import('../hook/commit-msg.js')).commitMsgHook(io, ctx, info, second, hookRead, { verify: () => import('../../../../../packages/verify/index.js'), spec: () => import('../../../../../packages/spec/index.js') });
  else if (first === 'pre-push') problems = await (await import('../hook/pre-push.js')).prePushHook(io, ctx, info, loadPushGraphs);
  else throw new Refused('USAGE', 'pullboard hook pre-commit | pre-merge-commit | commit-msg <file> | pre-push');
  if (typeof problems === 'number') return problems;
  if (!problems.length) return 0;
  // The fix note lives with the commit checks; a clean hook never loads them for it.
  const { FIX_NOTE } = await import('../../../../../packages/commits/index.js');
  io.err(`pullboard ${first}: blocked\n${problems.map((problem) => `  - ${io.guidance(problem)}`).join('\n')}\n${FIX_NOTE}`);
  return 1;
}

/** Run `pullboard hook` and return its exit code. */
export async function run(io, args) {
  // One memo for the whole hook run: the fixers and static checks ask Git the same read-only questions as the hook checks.
  return await withGitCommandMemo(() => hookCommand(io, args));
}
