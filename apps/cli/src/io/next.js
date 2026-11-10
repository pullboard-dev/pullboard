/** The command line side of `pullboard next`'s selection: its wait labels and the ports the moves cell selects through [C7]. */
import { claimWorktreeSnapshot } from '../../../../packages/seats/index.js';
import { nextOnce as nextOnceThrough } from '../../../../packages/moves/index.js';
import { recoverOwnSubmitHandoffs } from './submit/handoff.js';
import { mainLaneWork } from './next/steps.js';
import { withBoardRead } from './context.js';
import { agentDisplayName } from './context.js';
import { idArg } from './context.js';
import { withBoard } from './context.js';
import { checkMainVerifier } from './verify.js';
import { ordered } from './claim.js';
import { openItemFolder } from './item/folder.js';
import { liveFolderRefusal } from './item/folder.js';
import { claimOrdered } from './claim.js';
import { currentReworkRoutingPolicy } from './claim.js';
import { whoAmI } from './join.js';
import { MainSpecMerged } from './claim.js';
import { dirtyFiles } from './submit.js';

/** Label the holder at the start of a generated wait reason without rewriting its quoted reason. */
export function displayedWait(reason, agents, config) {
  return reason.replace(/^(\S+)( holds the )/, (_, id, rest) => `${agentDisplayName(agents, config, id)}${rest}`)
    .replace(/^(#\d+ is held by )(\S+)(: )/, (_, before, id, after) => `${before}${agentDisplayName(agents, config, id)}${after}`);
}

/** The board access, seat lookup, claim and item-folder helpers the moves cell's next loop calls, so it never loads the CLI. */
export const nextPorts = Object.freeze({ withBoardRead, withBoard, whoAmI, idArg, ordered, claimOrdered, currentReworkRoutingPolicy,
  MainSpecMerged, checkMainVerifier, dirtyFiles, recoverOwnSubmitHandoffs, openItemFolder, liveFolderRefusal, mainLaneWork, claimWorktreeSnapshot });

/**
 * One loop of `next` through the moves cell: claim the next free item, or reserve the next review (V15).
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {Promise<{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }>}
 */
export function nextOnce(ctx, values) {
  return nextOnceThrough(ctx, values, nextPorts);
}
