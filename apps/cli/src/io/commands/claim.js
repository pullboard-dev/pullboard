/** The pullboard claim command, in its own module so an item adding another command never edits these lines. */
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  headCommit,
} from '../../../../../packages/git/index.js';
import {
  events,
  getItem,
  listItems,
  sayQueuedReds,
} from '../../../../../packages/store/index.js';
import { itemFileCollisions } from '../../../../../packages/items/index.js';
import { outsideBuildProblem } from '../../../../../packages/items/index.js';
import { sayMapSlice } from '../../../../../packages/codemap/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { requireNoCoordinatorPath } from './add.js';
import { refuseClaimMissingPaths } from '../item/bar.js';
import { cleanItemFolders } from '../item/folder.js';
import { openItemFolder } from '../item/folder.js';
import {
  MainSpecMerged,
  actOn,
  claimFreezer,
  claimOrdered,
  idArg,
  ordered,
  whoAmI,
  wrongLaneGuidance,
} from '../entry.js';

/** Run `pullboard claim` and return its exit code. */
export async function run(io, { first }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const id = idArg(first);
  sayQueuedReds(io, board, () => me);
  cleanItemFolders(ctx, board, me, { spare: true });
  const filed = getItem(board, id);
  // A path missing from main is named before ownership: no lane can build a path that no longer exists (#5709).
  if (filed && !outsideBuildProblem(board, filed)) await refuseClaimMissingPaths(ctx, board, id);
  if (filed && !outsideBuildProblem(board, filed)) requireNoCoordinatorPath(ctx.config, me, { lane: filed.item_lane, title: filed.item_title, criterion: filed.item_criterion,
    check: filed.item_check, brief: filed.item_brief });
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
  try {
    itemFolder = await openItemFolder(ctx, me, id, { board, renewed: result.renewed,
      onArchive: archive => ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
        text: `Archived prior item folder ${archive.previousPath} from ${archive.previousHolder} before takeover.\nRecovery: ${JSON.stringify({ directory: archive.directory, head: archive.manifest.head, ref: archive.manifest.ref })}`,
        ref: null }]),
    });
  } catch (error) {
    // The claim is already recorded; a stale unregistered prior folder is reported in one line, not a crash [C7].
    if (!(error instanceof Refused) || error.code !== 'ITEM_FOLDER_UNREGISTERED') throw error;
    io.say(`warning: ${error.code}: ${error.message}; claim recorded`);
  }
  const commitRules = `Commit headers must be at most ${ctx.config.commits.maxHeader} characters. Submit drafts --infra for test import-path-only edits; explain assertion or other guarded edits with --infra "<why>".`;
  io.result?.({ id, ...result, ...(itemFolder ? { itemFolder } : {}), ...(warnings.length ? { warnings } : {}) });
  for (const warning of warnings) io.say(`warning: ${warning}; explicit claim retained`);
  await sayMapSlice(io, ctx, getItem(board, id), primaryCheckoutRoot);
  io.say(`${result.renewed ? 'renewed' : 'claimed'} #${first} until ${result.leaseUntil}; criterion frozen as ${result.digest.slice(0, 12)}`);
  if (itemFolder) io.say(`item folder: ${itemFolder}`);
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
