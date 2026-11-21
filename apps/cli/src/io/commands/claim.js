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
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { itemFileCollisions } from '../../../../../packages/items/index.js';
import { outsideBuildProblem } from '../../../../../packages/items/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { refuseClaimMissingPaths } from '../item/bar.js';
import { cleanItemFolders } from '../item/folder.js';
import { claimFolderRefusal } from '../item/folder.js';
import { claimedFolderProblem } from '../item/folder.js';
import { openItemFolder } from '../item/folder.js';
import { trunkBranch } from '../item/folder.js';
import { offMainHeadRefusal } from '../../../../../packages/moves/light.js';
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
  const phase = claimPhases();
  phase.time('sayQueuedReds', () => sayQueuedReds(io, board, () => me));
  phase.time('sayLag', () => sayLag(io, ctx));
  phase.time('cleanItemFolders', () => cleanItemFolders(ctx, board, me, { spare: true }));
  const filed = getItem(board, id);
  // A path missing from main is named before ownership: no lane can build a path that no longer exists (#5709).
  if (filed && !outsideBuildProblem(board, filed)) await phase.time('refuseClaimMissingPaths', () => refuseClaimMissingPaths(ctx, board, id));
  // A folder problem refuses here, before the move; another seat's live claim is left for the move to refuse (#5766).
  const heldElsewhere = filed && filed.item_owner !== me.id && isHeld(board, filed);
  if (filed && filed.item_lane === me.lane && !heldElsewhere) {
    const folder = await phase.time('claimFolderRefusal', () => claimFolderRefusal(ctx, board, me, id, { renewing: filed.item_owner === me.id && isHeld(board, filed) }));
    if (folder) throw folder;
  }
  // With claim.refuseOffMainHead on, a new claim in a folder whose HEAD is not on main refuses before the move [C7,#9104].
  const offMain = filed && !(filed.item_owner === me.id && isHeld(board, filed)) ? offMainHeadRefusal(ctx.info.root, { trunk: trunkBranch(ctx.info.root) }) : null;
  if (offMain) throw offMain;
  // laneMode off: any lane's item is on this seat's route, and the claim is made in that item's lane, as next does [C7,#8906].
  const laneOff = ctx.config.laneMode === 'off' && !ctx.info.isMain && filed !== undefined && filed !== null;
  let result;
  for (;;) {
    try {
      result = await phase.time('claimOrdered', () => claimOrdered(ctx, board, [id, { agentId: me.id, lane: laneOff ? filed.item_lane : me.lane, laneOff, leaseMs: ctx.config.leaseMs, itemFolder: true, freeze: claimFreezer(ctx, board), head: headCommit(ctx.info.root) }]));
      break;
    } catch (error) {
      if (!(error instanceof MainSpecMerged)) throw await wrongLaneGuidance(ctx, board, me, id, error);
      io.say(`merged main before claiming #${id}: added spec rows ${error.rows.join(', ')}`);
      me = whoAmI(ctx, board);
    }
  }
  const warnings = await phase.time('itemFileCollisions', () => itemFileCollisions(getItem(board, id), listItems(board, { all: true })));
  let itemFolder = null;
  let folderProblem = null;
  try {
    itemFolder = await phase.time('openItemFolder', () => openItemFolder(ctx, me, id, { board, renewed: result.renewed, onBehind: line => io.say(line),
      onArchive: archive => ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: 'note',
        text: `Archived prior item folder ${archive.previousPath} from ${archive.previousHolder} before takeover.\nRecovery: ${JSON.stringify({ directory: archive.directory, head: archive.manifest.head, ref: archive.manifest.ref })}`,
        ref: null }]),
    }));
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
  // The codemap cell loads only when the board asks for the slice (map.slice), so a plain claim never pays for it [C7].
  if (ctx.config.map?.slice === true) await (await import('../../../../../packages/codemap/index.js')).sayMapSlice(io, ctx, getItem(board, id), primaryCheckoutRoot);
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
  phase.say(io);
  return 0;
});
}

/**
 * Times each step of run() into a table and prints it on stderr, only when PULLBOARD_CLAIM_PROFILE is set; unset, every call is a plain pass-through [C7,#12396].
 * Why: the claim-median bar was released three times because no one had measured which claim phase is slow (#10311).
 *
 * @returns {{time: (name: string, work: () => any) => any, say: (io: any) => void}}
 */
function claimPhases() {
  const rows = environmentAdapter().get('PULLBOARD_CLAIM_PROFILE') ? new Map() : null;
  /** Add the elapsed milliseconds of one step; a step that runs twice, as claimOrdered does on a merged main, adds up. */
  const add = (name, start) => rows.set(name, (rows.get(name) ?? 0) + performance.now() - start);
  return {
    time(name, work) {
      if (!rows) return work();
      const start = performance.now();
      const out = work();
      if (typeof out?.then !== 'function') { add(name, start); return out; }
      return out.finally(() => add(name, start));
    },
    say(io) {
      if (!rows) return;
      const phases = [...rows].map(([phase, ms]) => ({ phase, ms })).sort((a, b) => b.ms - a.ms);
      const write = text => (io.stderr?.write ? io.stderr.write(text + '\n') : io.err?.(text));
      for (const row of phases) write(`claim profile: ${row.phase} ${Math.round(row.ms)} ms`);
      write(`claim profile: total ${Math.round(phases.reduce((sum, row) => sum + row.ms, 0))} ms; slowest three: ${phases.slice(0, 3).map(row => row.phase).join(', ')}`);
    },
  };
}
