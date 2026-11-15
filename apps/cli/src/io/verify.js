/** Helpers for `pullboard verify`: the main-checkout verifier and the landing command. Split from src/cli.js, which re-exports it [C7]. */
import { reviewerSeatStep } from './next/steps.js';
import * as store from '../../../../packages/store/index.js';
import { cdTo } from './context.js';
import { shellWord } from './context.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { displayAgentName } from '../../../../packages/seats/index.js';
import { mainCheckout } from '../../../../packages/git/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { landingRemote } from '../../../../packages/landing/index.js';
import { handMergeCommand } from '../../../../packages/landing/index.js';
import { primaryCheckoutRoot } from './worktree.js';

/**
 * Verifying from the main checkout files the verdict as the coordinator's (V9). An agent whose
 * shell started there would be taken for the coordinator, so the coordinator says so explicitly
 * and anyone else is sent back to a worktree.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {any} values
 */
export function checkMainVerifier(ctx, board, values) {
  if (values.as !== undefined && values.as !== COORDINATOR) throw new Refused('USAGE', '--as takes one value: coordinator');
  if (!ctx.info.isMain) {
    if (values.as) throw new Refused('USAGE', '--as coordinator works only in the main checkout; here you are the agent this worktree joined as');
    return;
  }
  if (values.as === COORDINATOR) return;
  const agents = store.listAgents(board).filter((agent) => agent.agent_id !== COORDINATOR);
  const listed = agents.length ? ` Agent worktrees: ${agents.slice(0, 6).map((agent) => `${displayAgentName(agent, ctx.config.agents.names)} at ${agent.agent_path}`).join('; ')}.` : '';
  const detached = tryGit(ctx.info.root, ['symbolic-ref', '-q', 'HEAD']).status !== 0 ? ' The main checkout is not on its branch; whoever switched it puts it back.' : '';
  throw new Refused('MAIN_IS_COORDINATOR',
    `this is the main checkout, so this verdict would be the coordinator's.${listed}${detached}`,
    reviewerSeatStep(ctx.info.root, ctx.config, values.verifyId),
  );
}
/**
 * Say the exact command that lands an accepted item in this repo [B3].
 * A repo with a push remote lands through pullboard land; one without merges by hand,
 * because pullboard land would refuse LAND_PUSH there.
 *
 * @param {any} info
 * @param {any} item
 * @param {string} [commit] - The exact checked composition the acceptance authorizes.
 * @param {{ spec?: any }} [options] - The spec the trailer's rows are ordered by.
 * @returns {string}
 */
export function landNext(info, item, commit = item.item_commit, { spec = null } = {}) {
  const mainRoot = primaryCheckoutRoot(info);
  const trunk = mainCheckout(info.root);
  const branch = trunk?.branch ?? '';
  const remote = landingRemote(info.root, branch);
  const command = remote ? 'pullboard land'
    : handMergeCommand(item, commit, { root: info.root, base: trunk?.commit, spec, quote: shellWord });
  if (!mainRoot) return `next: could not safely locate the primary checkout; run from the main checkout: ${command}`;
  if (remote) return `next: the coordinator lands it: ${cdTo(mainRoot)} ${command}`;
  return `next: this repo has no remote for pullboard land to push to, so the coordinator merges it on ${branch.replace(/^refs\/heads\//u, '') || 'the trunk'}: ${cdTo(mainRoot)} ${command}`;
}


/**
 * Moves a clean review worktree onto the submitted commit, detached, so a reviewer never runs
 * git switch by hand before a verdict (#2907). The main checkout and a dirty tree still refuse
 * NOT_AT_COMMIT; a dirty refusal names the files, since switching would carry or lose them.
 *
 * @param {any} info - The command's repository info.
 * @param {string} commit - The resolved submitted commit.
 * @param {string} short - The commit as `show` prints it.
 */
export function switchToSubmitted(info, commit, short) {
  const back = `check out the submitted commit first: ${cdTo(info.root)} git switch --detach ${short}`;
  if (info.isMain) throw new Refused('NOT_AT_COMMIT', back);
  const listed = args => tryGit(info.root, args).stdout.split('\n').filter(Boolean);
  const dirty = [...new Set([...listed(['diff', '--name-only', 'HEAD']), ...listed(['ls-files', '--others', '--exclude-standard'])])];
  if (dirty.length) throw new Refused('NOT_AT_COMMIT', `this review worktree has uncommitted files: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}; commit or remove them, then ${back}`);
  const switched = tryGit(info.root, ['switch', '--quiet', '--detach', commit]);
  if (switched.status !== 0) throw new Refused('NOT_AT_COMMIT', `${back} (${String(switched.stderr).trim()})`);
}
