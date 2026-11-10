import { isSubmitHandoffWorker } from '../../../../packages/sandbox/index.js';
/** Helpers for `pullboard submit`: changed files, stacked work and the submission record. Split from src/cli.js, which re-exports it [C7]. */
import { reviewerStartup } from './next/steps.js';
import * as store from '../../../../packages/store/index.js';
import { agentDisplayName } from './context.js';
import { withBoard } from './context.js';
import { git } from '../../../../packages/git/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { selectTestTiers } from '../../../../packages/gate/index.js';
import { recordReviewPacket } from '../../../../packages/verify/index.js';
import { barTestFiles } from '../../../../packages/verify/index.js';
import { frozenRowGates } from '../../../../packages/verify/index.js';
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
 * The test files from `candidates` that the selected gate runs: all of them when no tier plan applies, otherwise only
 * the plan's units, since journeys are deferred to the landing batch and nothing ticks a clause for a file never run [C7].
 *
 * @param {Iterable<string>} candidates
 * @param {string[] | null} units the tier plan's units, or null when the repository has no tier plan
 * @returns {Set<string>}
 */
export function selectedGateFiles(candidates, units) {
  const allowed = units ? new Set(units) : null;
  return new Set([...candidates].filter(file => /\.test\.js$/u.test(file) && (!allowed || allowed.has(file))));
}

/**
 * The test files the gate will run for this item: test files committed since the claim, kept to the gate's tier
 * selection, plus every test file the frozen criterion or the brief's "Test:" list names that exists at HEAD, which
 * submit runs whatever the selection says. A [test] clause naming one is ticked by the gate run, not by a builder fact
 * [C7]. A selection that cannot be read names no file, so the clause stays unticked.
 */
export function gateTestFiles(root, item) {
  const changed = filesSince(root, item.item_id, item.item_claim_head, 'HEAD');
  const named = barTestFiles(item).all.filter(file => tryGit(root, ['cat-file', '-e', `HEAD:${file}`]).status === 0);
  let units = null;
  // An unreadable selection ticks nothing from the changed files, but submit still runs the bar-named files.
  try { units = selectTestTiers(root, { base: item.item_claim_head ?? undefined, commit: 'HEAD' })?.units ?? null; } catch { return selectedGateFiles(named, null); }
  return new Set([...selectedGateFiles(changed, units), ...selectedGateFiles(named, null)]);
}

/**
 * The tests submit runs beside its selection: the item's call-adjacent tests, each cited spec row's gate test, and every
 * test file the frozen criterion or the brief's "Test:" list names, kept to files that exist at the commit. Why: seal and
 * tier selection pick tests by changed cells, so a clause naming a file in another cell had no recorded run and review
 * rejected a green gate INSUFFICIENT_EVIDENCE (#3533, #3253, #3353 on 7 Nov). Bar files are added with or without an
 * affected-tests runner, so a project with none configured still gets its named files run: bar test files are
 * JavaScript, and the gate runs them with Node's test runner when no runner is configured (namedFileRunner) [V4,C7].
 *
 * @param {string} root
 * @param {object} item - The held item, with its frozen bar and brief.
 * @param {string} commit - The submitted commit the files must exist at.
 * @param {{ crossRunTests?: string[] }} [options]
 * @returns {string[]} Sorted repo-relative test files for runSubmitGate's `crossRunTests`.
 */
export function namedProofTests(root, item, commit, { crossRunTests = [] } = {}) {
  const named = [...frozenRowGates(item).map(row => row.file), ...barTestFiles(item).all];
  return [...new Set([...crossRunTests, ...named.filter(file => tryGit(root, ['cat-file', '-e', `${commit}:${file}`]).status === 0)])].sort();
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

/**
 * Refuse a head whose new commits since main all belong to another item, so a branch is never gated as the wrong item [V1].
 *
 * Why: #2512 was once submitted from #2344's worktree and #2344's branch was gated as #2512. Commits with no
 * trailer, and branches with no trailers at all, stay allowed; every new source commit counts, also those a --no-ff merge brings in; only another item's trailer with none of this item's refuses.
 *
 * @param {string} root
 * @param {any} item - The item being submitted.
 * @param {string} commit - The head being submitted.
 * @param {{ commit: string } | null} trunk - Current accepted main.
 * @returns {void}
 */
export function refuseWrongBranch(root, item, commit, trunk) {
  if (!trunk?.commit) return;
  const log = tryGit(root, ['log', '--no-merges', '--format=%(trailers:key=Pullboard-Item,valueonly,separator=%x2C)%x01', `${trunk.commit}..${commit}`]);
  if (log.status !== 0) return;
  const named = new Set(log.stdout.split('\x01').flatMap((entry) => entry.split(',')).map((value) => Number(value.trim().replace(/^#/u, ''))).filter((value) => Number.isSafeInteger(value) && value > 0));
  if (!named.size || named.has(item.item_id)) return;
  const other = [...named].sort((a, b) => a - b)[0];
  throw new Refused('WRONG_BRANCH', `this head's new commits belong to item #${other}, not #${item.item_id}; submit #${other} from here, or switch to the branch built for #${item.item_id}`);
}

/** Run every stack refusal a submit owes: another item's unverified commits, then a head built for another item [V1]. */
export function refuseUnsubmittableStack(root, board, item, commit, trunk) {
  refuseWrongBranch(root, item, commit, trunk);
  refuseUnverifiedStack(root, board, item, commit, trunk);
}

/** Report and pin the original submitted commit, including a recovered acknowledged outcome. */
export async function reportSubmission(ctx, id, commit, gate, doctrine = []) {
  const { root } = ctx.info;
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  const submission = { id, commit, pin, gate, ...(doctrine.length ? { doctrine } : {}) };
  if (ctx.submissionResult) ctx.submissionResult.value = submission;
  if (!isSubmitHandoffWorker(ctx)) try {
    const { deliverActivity, activityDeliveryLines } = await import('../../../../packages/activity/index.js');
    const delivery = await deliverActivity(ctx, { afterSubmit: true, directShouts: false }, { agentDisplayName, evidenceLine, ordered, whoAmI, withBoard });
    submission.activity = { ...delivery.activity, budget: delivery.budget };
    for (const line of activityDeliveryLines(delivery, ctx.config, { agentDisplayName, evidenceLine })) ctx.io.say(line);
  } catch (error) {
    submission.activity = { receipt: { recorded: false, code: error.code ?? 'ACTIVITY_DELIVERY_FAILED', message: error.message } };
    ctx.io.err(`submitted #${id}, but its activity delivery failed: ${error.message}; read pullboard inbox to retry delivery`);
  }
  // A green gate, or one red only in main's named cases, stores the review packet for this head now (#2451, #3449).
  if (gate.green || gate.knownMainFailures) await recordReviewPacket(ctx, id, (work) => withBoard(ctx, (board) => work(board, store)), { errors: gate.failures ?? [], mainReceiptIds: gate.mainReceiptIds ?? [] });
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

