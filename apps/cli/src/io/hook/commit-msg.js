/** The commit-msg checks, loaded only by that hook so a pre-commit start never pays for them [C7,H24]. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { itemFolderIdentity } from '../../../../../packages/items/light.js';
import { itemFolderPath } from '../../../../../packages/items/light.js';
import { awaitingGateOrReview } from '../../../../../packages/store/light.js';
import * as store from '../../../../../packages/store/light.js';
import { landingBatchItemsAtRoot } from '../../../../../packages/landing/light.js';
import { landingBatchOwnsRoot } from '../../../../../packages/landing/light.js';
import {
  commitCitationWarnings,
  commitMsgProblems,
  fixCommitHeader,
  landingRows,
  pendingCommitSignoffProblem,
  prepareCommitMetadata,
} from '../../../../../packages/commits/index.js';
import {
  landingBatchesAt,
  headCommit,
  gitPath,
  tryGit,
} from '../../../../../packages/git/index.js';

/**
 * Claims that may stamp trailers: the live ones, or the submitted item's own claim when only its gate handoff remains,
 * so a fix commit still cites the item while the gate runs [C7,#2882].
 *
 * @param {any[]} claims - This seat's claimed items.
 * @param {(item: any) => unknown} pending - Whether the item waits on its own queued or running gate, hand-off or pulled.
 * @returns {any[]}
 */
export function submittedClaimsFallback(claims, pending) {
  const live = claims.filter(item => !pending(item));
  return live.length ? live : claims;
}

/**
 * Name the item folder for each claim a seat holds when a commit in the seat checkout itself is refused.
 * Why: a new user following the README commits in the seat; the refusal (a spec row the seat has not merged yet) never said the work belongs in the item folder [C7,#7946].
 * A claim whose folder was never created (a lane move or top-up makes one) gets a line naming pullboard claim, never a path that does not exist [C7,#12023].
 *
 * @param {(ctx: any, read: (board: any) => any) => any} hookRead
 * @param {any} ctx hook context
 * @param {string} root the committing checkout
 * @returns {string[]} one next-step line per claim, or none outside a seat checkout
 */
function seatItemFolderHints(hookRead, ctx, root) {
  return hookRead(ctx, (board) => {
    const seat = store.agentAt(board, root);
    if (!seat?.agent_path) return [];
    return store.listItems(board, { lane: seat.agent_lane })
      .filter((item) => item.item_status === 'claimed' && item.item_owner === seat.agent_id && !awaitingGateOrReview(board, item))
      .map((item) => {
        const folder = itemFolderPath(seat.agent_path, item.item_id);
        if (!existsSync(folder)) return `this is the seat checkout; #${item.item_id} has no item folder yet; run pullboard claim ${item.item_id} from the seat checkout to create it`;
        return `this is the seat checkout; build and commit #${item.item_id} in its item folder ${folder}, then cd ${folder} && pullboard submit ${item.item_id}`;
      });
  }) ?? [];
}

/**
 * Run the commit-msg checks for one commit message.
 *
 * @param {any} io
 * @param {any} ctx hook context
 * @param {any} info the committing checkout
 * @param {string} second the message file
 * @param {(ctx: any, read: (board: any) => any) => any} hookRead
 * @param {{ verify: () => Promise<any>, spec: () => Promise<any> }} loaders loads the verify and spec cells, named by the hook command
 * @returns {Promise<number | string[]>} an exit code when the hook ends early, else the problems found
 */
export async function commitMsgHook(io, ctx, info, second, hookRead, loaders) {
  const originalMessage = readFileSync(second ?? '', 'utf8');
  // A landing worktree checks each verified item's landing commit; that closure (the verify cell) loads only then, on a second read.
  /** @param {(board: any, item: any) => any} checkedCommit */
  const readContext = checkedCommit => hookRead(ctx, board => {
    const agent = (store.agentAt(board, info.root) ?? itemFolderIdentity(board, info.root)?.agent);
    const folderItem = itemFolderIdentity(board, info.root)?.item;
    const batches = info.isMain ? [] : landingBatchesAt(board, info.root);
    const landing = info.isMain || batches.some(batch => landingBatchOwnsRoot(batch, info.root));
    // The open list holds every claim; the closed items are read only where a landing may merge a verified one.
    const open = store.listItems(board);
    const items = landing ? store.listItems(board, { all: true }) : open;
    return {
      migration: landing && existsSync(gitPath(info.root, 'MERGE_HEAD'))
        ? { base: headCommit(info.root), side: tryGit(info.root, ['rev-parse', '--verify', 'MERGE_HEAD']).stdout } : null,
      claims: submittedClaimsFallback(open.filter(item => item.item_status === 'claimed' && item.item_owner === agent?.agent_id && (folderItem === undefined || item.item_id === folderItem)),
        item => awaitingGateOrReview(board, item)),
      landings: info.isMain ? items.filter(item => item.item_status === 'verified' && !item.item_merged_commit)
        : landingBatchItemsAtRoot(batches, info.root, items, item => checkedCommit(board, item)),
    };
  }) ?? {};
  let askedForLanding = false;
  let metadataContext = readContext(() => { askedForLanding = true; return null; });
  if (askedForLanding) {
    const { checkedLandingCommit } = await loaders.verify();
    metadataContext = readContext(checkedLandingCommit);
  }
  const { loadSpec, withRowDrafts } = await loaders.spec();
  const spec = withRowDrafts(loadSpec(info.root, ctx.config), hookRead(ctx, (board) => store.rowDrafts(board)));
  const prepared = prepareCommitMetadata(originalMessage, { ...metadataContext, spec, syncMerge: existsSync(gitPath(info.root, 'MERGE_HEAD')) });
  // A capitalised subject and a trailing period are fixed here and said, never refused, so they cost no retry [C7,#5775]; an over-long header is refused with its length, never cut [C7,#12030].
  const styled = fixCommitHeader(prepared.message, ctx.config.commits);
  styled.notes.forEach((note) => io.err(`pullboard commit-msg: fixed: ${note}`));
  const message = styled.message;
  const signoff = pendingCommitSignoffProblem(info.root, message);
  if (signoff) { io.err(signoff); return 1; }
  commitCitationWarnings(message, { spec, doctrine: ctx.doctrine })
    .forEach((warning) => io.say(`pullboard commit-msg: warning: ${warning}`));
  const claimedItems = spec.rows.some(row => row.status === 'approved') ? [] : (hookRead(ctx, board => {
    const agent = (store.agentAt(board, info.root) ?? itemFolderIdentity(board, info.root)?.agent);
    return agent ? store.listItems(board, { lane: agent.agent_lane }).filter(item =>
      item.item_status === 'claimed' && item.item_owner === agent.agent_id && !awaitingGateOrReview(board, item)).map(item => item.item_id) : [];
  }) ?? []);
  // Only the main checkout or a landing worktree merges a verified item; elsewhere no trailer exempts a header.
  const rowlessLandings = (metadataContext.landings ?? []).filter(item => !landingRows(item).length).map(item => item.item_id);
  const problems = [...prepared.problems, ...commitMsgProblems(message, { rules: ctx.config.commits, spec, doctrine: ctx.doctrine, claimedItems, rowlessLandings })];
  if (problems.length) problems.push(...seatItemFolderHints(hookRead, ctx, info.root));
  if (!problems.length && message !== originalMessage) writeFileSync(second, message);
  return problems;}
