/** The pullboard claim command, in its own module so an item adding another command never edits these lines. */
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  headCommit,
  withGitCommandMemo,
} from '../../../../../packages/git/index.js';
import {
  events,
  getItem,
  isHeld,
  listItems,
  sayQueuedReds,
} from '../../../../../packages/store/index.js';
import { itemFileCollisions } from '../../../../../packages/items/index.js';
import { outsideBuildProblem } from '../../../../../packages/items/index.js';
import { sayMapSlice } from '../../../../../packages/codemap/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { onTrunk } from '../item/bar.js';
import { refuseClaimMissingPaths } from '../item/bar.js';
import { requireNoCoordinatorPath } from '../item/bar.js';
import { cleanItemFolders } from '../item/folder.js';
import { claimFolderRefusal } from '../item/folder.js';
import { claimedFolderProblem } from '../item/folder.js';
import { openItemFolder } from '../item/folder.js';
import { trunkBranch } from '../item/folder.js';
import { offMainHeadRefusal } from '../../../../../packages/moves/index.js';
import { actOn } from '../board/access.js';
import {
  MainSpecMerged,
  claimFreezer,
  claimOrdered,
  ordered,
  wrongLaneGuidance,
} from '../claim.js';
import { idArg } from '../context.js';
import { whoAmI } from '../join.js';
import { sayLag } from '../lag.js';

/** Run `pullboard claim` and return its exit code. */
export async function run(io, { first }) {
  // One claim asks Git for the worktree list and trunk once; a call that writes clears the memory [C7].
  const act = (work) => withGitCommandMemo(() => actOn(io, work));
  return act(async (ctx, board, me) => {
  const id = idArg(first);
  sayQueuedReds(io, board, () => me);
  sayLag(io, ctx);
  cleanItemFolders(ctx, board, me, { spare: true });
  const filed = getItem(board, id);
  // A path missing from main is named before ownership: no lane can build a path that no longer exists (#5709).
  if (filed && !outsideBuildProblem(board, filed)) await refuseClaimMissingPaths(ctx, board, id);
  if (filed && !outsideBuildProblem(board, filed)) requireNoCoordinatorPath(ctx.config, me, { lane: filed.item_lane, title: filed.item_title, criterion: filed.item_criterion,
    check: filed.item_check, brief: filed.item_brief }, { present: onTrunk(ctx.info.root) });
  // A folder problem refuses here, before the move; another seat's live claim is left for the move to refuse (#5766).
  const heldElsewhere = filed && filed.item_owner !== me.id && isHeld(board, filed);
  if (filed && filed.item_lane === me.lane && !heldElsewhere) {
    const folder = await claimFolderRefusal(ctx, board, me, id, { renewing: filed.item_owner === me.id && isHeld(board, filed) });
    if (folder) throw folder;
  }
  // With claim.refuseOffMainHead on, a new claim in a folder whose HEAD is not on main refuses before the move [C7,#9104].
  const offMain = filed && !(filed.item_owner === me.id && isHeld(board, filed)) ? offMainHeadRefusal(ctx.info.root, { trunk: trunkBranch(ctx.info.root) }) : null;
  if (offMain) throw offMain;
  let result;
  for (;;) {
    try {
      result = await claimOrdered(ctx, board, [id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, itemFolder: true, freeze: claimFreezer(ctx, board), head: headCommit(ctx.info.root) }]);
      break;
    } catch (error) {
      if (!(error instanceof MainSpecMerged)) throw await wrongLaneGuidance(ctx, board, me, id, error);
      io.say(`merged main before claiming #${id}: added spec rows ${error.rows.join(', ')}`);
      me = whoAmI(ctx, board);
    }
  }
  const warnings = itemFileCollisions(getItem(board, id), listItems(board, { all: true }));
  let itemFolder = null;
  let folderProblem = null;
  try {
    itemFolder = await openItemFolder(ctx, me, id, { board, renewed: result.renewed, onConflict: (files, line) => io.say(`warning: ${line}`),
      onArchive: archive => ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
        text: `Archived prior item folder ${archive.previousPath} from ${archive.previousHolder} before takeover.\nRecovery: ${JSON.stringify({ directory: archive.directory, head: archive.manifest.head, ref: archive.manifest.ref })}`,
        ref: null }]),
    });
  } catch (error) {
    // The claim is already recorded, so a folder refusal is reported with the claim, never as the command's refusal (#5766).
    if (!(error instanceof Refused)) throw error;
    if (error.code === 'ITEM_FOLDER_UNREGISTERED') io.say(`warning: ${error.code}: ${error.message}; claim recorded`);
    else folderProblem = claimedFolderProblem(error, id);
  }
  const commitRules = `Commit headers must be at most ${ctx.config.commits.maxHeader} characters. Submit drafts --infra for test import-path-only edits; explain assertion or other guarded edits with --infra "<why>".`;
  io.result?.({ id, ...result, ...(itemFolder ? { itemFolder } : {}), ...(warnings.length ? { warnings } : {}),
    ...(folderProblem ? { folderProblem, next: folderProblem.next } : {}) });
  for (const warning of warnings) io.say(`warning: ${warning}; explicit claim retained`);
  await sayMapSlice(io, ctx, getItem(board, id), primaryCheckoutRoot);
  io.say(`${result.renewed ? 'renewed' : 'claimed'} #${first} until ${result.leaseUntil}; criterion frozen as ${result.digest.slice(0, 12)}`);
  if (itemFolder) io.say(`item folder: ${itemFolder}`);
  if (folderProblem) io.say(`item folder not opened: [${folderProblem.code}] ${folderProblem.message}; the claim is recorded`);
  io.say(commitRules);
  // A claim released for idleness carries its work: the next builder sees the pinned commit and the files it changed (#1225).
  if (!result.renewed) {
    const released = events(board, { itemId: id }).filter(event => event.event_kind === 'release').at(-1);
    const detail = released ? JSON.parse(released.event_detail) : null;
    const handoff = detail?.idleClaim?.handoff;
    if (handoff?.pin) {
      const more = (handoff.changedCount ?? handoff.changedFiles.length) - handoff.changedFiles.length;
      io.say(`handoff from ${detail.idleClaim.holder}: last commit ${handoff.head.slice(0, 12)} kept at ${handoff.pin}; changed ${handoff.changedFiles.join(', ') || 'no files'}${more > 0 ? `, +${more} more` : ''}; merge it with git merge ${handoff.pin}`);
    } else if (handoff) {
      io.say(`handoff from ${detail.idleClaim.holder}: no work could be pinned (${handoff.unpinned}); start from the item facts`);
    } else if (/refs\/pullboard\/handoffs\//u.test(detail?.reason ?? '')) {
      io.say(`handoff from ${released.event_by}: ${detail.reason}`);
    }
  }
  return 0;
});
}
