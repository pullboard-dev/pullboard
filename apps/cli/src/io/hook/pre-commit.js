/** The pre-commit and pre-merge-commit checks, loaded only by those hooks so a commit-msg start never pays for them [C7,H24]. */
import { existsSync } from 'node:fs';
import { stagedShimImportProblems } from '../../../../../packages/codemap/index.js';
import { importsIn } from '../../../../../packages/codemap/light.js';
import { itemFolderIdentity } from '../../../../../packages/items/light.js';
import { itemFolderPath } from '../../../../../packages/items/light.js';
import { busyRefusal } from '../../../../../packages/store/light.js';
import { openBoardReadOnly } from '../../../../../packages/store/light.js';
import { awaitingGateOrReview } from '../../../../../packages/store/light.js';
import * as store from '../../../../../packages/store/light.js';
import { trunkRef } from '../../../../../packages/sandbox/light.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { applyFixers } from '../../../../../packages/commits/index.js';
import { fixStagedImportBindings } from '../../../../../packages/commits/index.js';
import { preCommitProblems } from '../../../../../packages/commits/index.js';
import {
  checkoutBranch,
  checkoutRefCommit,
  landingBatchesAt,
  tryGit,
  withGitCommandMemo,
} from '../../../../../packages/git/index.js';
import { stagedStaticProblems } from './static.js';
import { stagedCeilingTables } from './static.js';

/** Whether a staged change may touch a spec or doctrine row; only then does the loosening check, in the doctrine graph, load. */
const MAY_TOUCH_ROWS = /\.md\0|doctrine|spec|\.pullboard/iu;

/**
 * Refuse a commit of item work in a seat checkout, naming the item folder to use (#3691).
 * Why: builders committed on <lane>/item-<id> inside their seat checkout, which left the seat on an item branch and
 * blocked every other seat from that item with ITEM_FOLDER_PROTECTED. Item work belongs in the seat's item folder.
 *
 * @param {string} root the committing checkout
 * @param {{ agent_id: string, agent_path: string } | null | undefined} seat the seat whose own checkout this is, if any
 */
export function refuseSeatItemWork(root, seat) {
  if (!seat?.agent_path) return;
  const match = /^[^/]+\/item-([1-9]\d*)$/u.exec(checkoutBranch(root) ?? '');
  if (!match) return;
  const folder = itemFolderPath(seat.agent_path, Number(match[1]));
  throw new Refused('ITEM_WORK_IN_SEAT', `item work for #${match[1]} is committed in the seat checkout ${root}; item work is built in its item folder ${folder}`,
    `move the change to ${folder} (pullboard claim ${match[1]} opens it), commit there, and switch this seat checkout off the item branch`);
}

/**
 * Run the pre-commit checks for one commit.
 *
 * @param {any} io
 * @param {any} ctx hook context
 * @param {any} info the committing checkout
 * @param {string} first the hook name
 * @param {(ctx: any, read: (board: any) => any) => any} hookRead
 * @param {Function} rowDecisions the spec cell's row decisions, named by the hook command
 * @returns {Promise<number | string[]>} an exit code when the hook ends early, else the problems found
 */
export async function preCommitHook(io, ctx, info, first, hookRead, rowDecisions) {
  // Two large graphs load only when this commit can need them: the doctrine check for a staged row edit, and the hand-off actor for a merge commit [C7,H24].
  const staged = tryGit(info.root, ['diff', '--cached', '--name-status', '-z', '-M']).stdout;
  const checkLoosening = (MAY_TOUCH_ROWS.test(staged) || [ctx.config.spec, ctx.config.practice].some(file => file && staged.includes(file))) ? (await import('../../../../../packages/doctrine/index.js')).checkLoosening
    : () => { throw new Refused('HOOK_LOOSENING_UNLOADED', 'a staged change reached the row-loosening check without loading it', 'report this refusal to the coordinator with pullboard shout'); };
  const approvedRowPorts = { boardBusyError: busyRefusal, openBoardReadOnly, rowDecisions, checkLoosening };
  const submitHandoffHookActor = first === 'pre-merge-commit' ? (await import('../../../../../packages/sandbox/index.js')).submitHandoffHookActor : null;
  // A composed run's fixers already ran against the real index, so the checked bytes are the committed bytes (#2593).
  if (process.env.PULLBOARD_HOOK_COMPOSED !== '1') [...applyFixers(info.root, ctx.config.fix), ...fixStagedImportBindings(info.root)].forEach((note) => io.err(`pullboard pre-commit: ${note}`));
  // Behind docs.regenerateOnCommit (off by default): the generated documentation copies follow the declarations they are built from [C7,#9664].
  if (process.env.PULLBOARD_HOOK_COMPOSED !== '1' && (await import('../../../../../packages/config/index.js')).docsRegenerateOnCommit()) {
    const { regenerateStagedDocs } = await import('../generated/docs.js');
    const { openBoard } = await import('../../../../lib/index.js');
    regenerateStagedDocs(info.root, { openBoard }).forEach((note) => io.err(`pullboard pre-commit: ${note}`));
  }
  if (process.env.PULLBOARD_HOOK_COMPOSED === 'fix') return 0;
  // A boardless clone with board.url set is a seat whose lane the served board names, never the coordinator [P7].
  const remoteSeat = existsSync(ctx.file) ? null : await (await import('../remote/board.js')).remoteHookSeat(info.root);
  const isMain = info.isMain && !remoteSeat;
  const agent = remoteSeat ?? (isMain ? null : hookRead(ctx, (board) => (store.agentAt(board, info.root) ?? itemFolderIdentity(board, info.root)?.agent)
    ?? (first === 'pre-merge-commit' ? submitHandoffHookActor?.(ctx, board) : null)));
  // The landing door loads only when a landing batch names this checkout, so an ordinary commit never pays for its graph [C7,#8841].
  const batches = hookRead(ctx, (board) => landingBatchesAt(board, info.root)) ?? [];
  const ownsRoot = batches.length ? (await import('../../../../../packages/landing/light.js')).landingBatchOwnsRoot : null;
  const landing = batches.some((batch) => ownsRoot(batch, info.root));
  if (first === 'pre-commit' && !landing) refuseSeatItemWork(info.root, hookRead(ctx, (board) => store.agentAt(board, info.root)));
  if (landing) io.caller('coordinator', info.root);
  else if (agent) io.caller('seat', info.root);
  const criterion = agent ? hookRead(ctx, board => {
    const folderItem = itemFolderIdentity(board, info.root)?.item;
    const claims = store.listItems(board).filter(item => item.item_status === 'claimed'
      && item.item_owner === agent.agent_id && (folderItem === undefined || item.item_id === folderItem)
      && !awaitingGateOrReview(board, item));
    return claims.length === 1 && claims[0].item_frozen ? JSON.parse(claims[0].item_frozen).criterion ?? '' : '';
  }) ?? '' : '';
  const trunk = trunkRef(info.root);
  // The trunk branch's commit comes from Git's ref files when they can answer, so no process is started for it.
  const accepted = (trunk?.startsWith('refs/heads/') ? checkoutRefCommit(info.root, trunk) : null) || tryGit(info.root, ['rev-parse', '--verify', trunk]).stdout.trim() || 'HEAD';
  const shimImports = options => stagedShimImportProblems({ ...options, accepted, parseImports: importsIn, criterion });
  const staticProblems = await stagedStaticProblems(info.root, process.env);
  const ceilingTables = await stagedCeilingTables(process.env);
  return [...staticProblems, ...withGitCommandMemo(() => preCommitProblems({ shimImports, approvedRowPorts, ceilingTables, root: info.root, isMain: isMain || landing, config: ctx.config, agent, boardFile: ctx.file, preMergeHook: first === 'pre-merge-commit', onNotice: (message) => io.err(`pullboard pre-commit: warning: ${message}`) }))];
}
