/** Helpers for `pullboard submit`: changed files, stacked work and the submission record. Split from src/cli.js, which re-exports it [C7]. */
import { reviewerStartup } from '../next-steps.js';
import * as store from '../board.js';
import { agentDisplayName } from '../cli-context.js';
import { withBoard } from '../cli-context.js';
import { git } from '../git.js';
import { tryGit } from '../git.js';
import { Refused } from '../refused.js';
import { ordered } from './claim.js';
import { whoAmI } from './join.js';
import { evidenceLine } from './shout.js';
import { primaryCheckoutRoot } from './worktree.js';

/**
 * The paths with uncommitted changes in a worktree, untracked files included.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function dirtyFiles(root) {
  return tryGit(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

/**
 * The files an item's own commits changed since its claim (N21). First parents only, so main merged
 * into a lane branch is not counted as the item's work; and nothing another item submitted, such as
 * a verified dependency fast-forwarded in, which merges no commit to skip.
 *
 * @param {string} root
 * @param {number} id
 * @param {string | null} from
 * @param {string} to
 * @returns {string[]}
 */
export function filesSince(root, id, from, to) {
  if (!from) return [];
  const others = [`--exclude=refs/pullboard/items/${id}/*`, '--glob=refs/pullboard/items/*'];
  const result = tryGit(root, ['log', '--first-parent', '--no-merges', '--no-renames', '--format=', '--name-only', to, '--not', from, ...others]);
  return result.status === 0 ? [...new Set(result.stdout.split('\n').filter(Boolean))].sort() : [];
}

/** Refuse a candidate containing another item's unverified submitted commit [V1].
 *
 * Trunk-reachable commits are already landed, including when the candidate is trunk itself.
 * Inspect all remaining reachable commits, including merged topic parents.
 *
 * @param {string} root
 * @param {any} board
 * @param {any} item
 * @param {string} commit
 * @param {{ ref: string, commit: string } | null} trunk
 * @returns {void}
 */
export function refuseUnverifiedStack(root, board, item, commit, trunk) {
  const trunkRange = trunk?.commit
    ? tryGit(root, ['rev-list', `${trunk.commit}..${commit}`])
    : { status: 1, stdout: '' };
  if (trunkRange.status !== 0) {
    throw new Refused('NO_POLICY', 'the current trunk range cannot be read; restore Git history and retry the submit or verification');
  }
  const commits = new Set(trunkRange.stdout.split('\n').filter(Boolean));
  const stacked = store.unverifiedSubmissions(board)
    .find((other) => other.item_id !== item.item_id && commits.has(other.item_commit));
  if (stacked) {
    throw new Refused(
      'STACKED_ON_UNVERIFIED',
      `#${item.item_id} includes unverified item #${stacked.item_id} at ${stacked.item_commit}; wait for #${stacked.item_id} to be accepted or rebuild without its commits before continuing`,
    );
  }
}

/** Report and pin the original submitted commit, including a recovered acknowledged outcome. */
export async function reportSubmission(ctx, id, commit, gate, doctrine = []) {
  const { root } = ctx.info;
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  const submission = { id, commit, pin, gate, ...(doctrine.length ? { doctrine } : {}) };
  if (ctx.submissionResult) ctx.submissionResult.value = submission;
  try {
    const { deliverActivity, activityDeliveryLines } = await import('../activity-delivery-cli.js');
    const delivery = await deliverActivity(ctx, { afterSubmit: true, directShouts: false }, { agentDisplayName, evidenceLine, ordered, whoAmI, withBoard });
    submission.activity = { ...delivery.activity, budget: delivery.budget };
    for (const line of activityDeliveryLines(delivery, ctx.config, { agentDisplayName, evidenceLine })) ctx.io.say(line);
  } catch (error) {
    submission.activity = { receipt: { recorded: false, code: error.code ?? 'ACTIVITY_DELIVERY_FAILED', message: error.message } };
    ctx.io.err(`submitted #${id}, but its activity delivery failed: ${error.message}; read pullboard inbox to retry delivery`);
  }
  ctx.io.result?.(submission);
  ctx.io.say(`submitted #${id} at ${commit.slice(0, 12)}; ${gate.report}`);
  ctx.io.say(`pinned as ${pin}, so this work can't be lost; keep your worktree until it is merged`);
  ctx.io.say(`next: ${reviewerStartup(primaryCheckoutRoot(ctx.info), ctx.config, id)}`);
  if (ctx.afterSubmission) {
    const handed = await ctx.afterSubmission(submission);
    if (ctx.submissionResult) ctx.submissionResult.value = handed;
  }
  return 0;
}

