/** @pullboard-module-loads packages/moves/src/io/selection.js */
/** The command line side of `pullboard next`'s selection: its wait labels and the ports the moves cell selects through [C7]. */
import { claimWorktreeSnapshot } from '../../../../packages/seats/index.js';
import { firstUnderLabelMax } from '../../../../packages/queue/index.js';
import { pickForLabelMinimum } from '../../../../packages/queue/index.js';
import { createRequire } from 'node:module';
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
import * as store from '../../../../packages/store/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { nextHoldAboveLoad } from '../../../../packages/config/index.js';

/** Next's selection, loaded at the first selection: its landing and gate loads never ride on the command's load [C7,#7081]. */
const requireModule = createRequire(import.meta.url);

/** Label the holder at the start of a generated wait reason without rewriting its quoted reason. */
export function displayedWait(reason, agents, config) {
  return reason.replace(/^(\S+)( holds the )/, (_, id, rest) => `${agentDisplayName(agents, config, id)}${rest}`)
    .replace(/^(#\d+ is held by )(\S+)(: )/, (_, before, id, after) => `${before}${agentDisplayName(agents, config, id)}${after}`);
}

/** The board access, seat lookup, claim and item-folder helpers the moves cell's next loop calls, so it never loads the CLI. */
export const nextPorts = Object.freeze({ withBoardRead, withBoard, whoAmI, idArg, ordered, claimOrdered, currentReworkRoutingPolicy,
  MainSpecMerged, checkMainVerifier, dirtyFiles, openItemFolder, liveFolderRefusal, mainLaneWork, claimWorktreeSnapshot, pickForLabelMinimum, firstUnderLabelMax });

/**
 * One loop of `next` through the moves cell: claim the next free item, or reserve the next review (V15).
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {Promise<{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }>}
 */
export async function nextOnce(ctx, values) {
  const held = loadHold(ctx, values);
  if (held) return held;
  return requireModule('../../../../packages/moves/src/io/selection.js').nextOnce(ctx, values, nextPorts);
}

/**
 * With next.holdAboveLoad on, the idle answer for a seat on a machine above machine.loadCeiling: no new build or review claim,
 * and the load named as the reason. A seat that holds a claim still resumes it, so work in progress is never stranded [C7,#9703].
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ reasons: string[] }|null} The idle answer, or null when next may hand a claim.
 */
export function loadHold(ctx, values) {
  if (!nextHoldAboveLoad()) return null;
  const verdict = requireModule('../../../../packages/resources/index.js').machineLoadVerdict(loadMachineSettings());
  if (!verdict.held) return null;
  if (!values.build && withBoardRead(ctx, board => heldTop(ctx, board).length)) return null;
  return { reasons: [`next hands no new work: ${verdict.line}`] };
}

/** Ids of this seat's live top-level build claims, the ones the claim guard counts against N (reworks and gated work aside) [C7]. */
function heldTop(ctx, board) {
  const me = whoAmI(ctx, board).id, now = board.clock.now().toISOString();
  return store.listItems(board).filter(item => item.item_status === 'claimed' && item.item_owner === me && item.item_parent_id === null
    && item.item_lease_until > now && !(item.item_verdict === 'REJECT' && item.item_built_by === me) && !store.awaitingGateOrReview(board, item));
}

/** Ids of the build claims this seat holds now, in id order [C7]. */
export function seatClaims(ctx) {
  return withBoardRead(ctx, board => heldTop(ctx, board).map(item => item.item_id).sort((a, b) => a - b));
}

/**
 * Claim ready items for this seat, each sharing no file with work it holds, until it holds N build claims [C7,#6263,#7461].
 * Why: a seat builds its next item while earlier ones' tests run; N is claims.perSeat or the board's free slots per live seat,
 * and the claim guard records the N it used. `most` bounds one call: submit adds one at a time.
 *
 * @param {any} ctx
 * @param {any} values
 * @param {{ most?: number }} [options]
 * @returns {Promise<any[]>} The new claims, in claim order.
 */
export async function topUpClaims(ctx, values, { most = Infinity } = {}) {
  const omit = new Set(values.omitIds ?? []);
  const taken = [];
  const perSeat = Number.isSafeInteger(ctx.config.claims?.perSeat) ? ctx.config.claims.perSeat : null;
  for (let tries = 0; tries < 10 && taken.length < most; tries += 1) {
    const room = withBoardRead(ctx, board => {
      const me = whoAmI(ctx, board).id, items = store.listItems(board);
      const mine = items.filter(item => item.item_status === 'claimed' && item.item_owner === me);
      // A source the seat submitted and still awaits a verdict on holds its files too, so no extra claim overlaps it [#7061].
      const awaiting = items.filter(item => item.item_status === 'submitted' && item.item_built_by === me);
      const held = new Set([...mine, ...awaiting].flatMap(item => store.itemFiles(item)));
      // A claim the seat already holds is left out too, or selection hands it back as held and nothing new is claimed.
      for (const item of mine) omit.add(item.item_id);
      for (const item of items) if (item.item_status === 'open' && store.itemFiles(item).some(file => held.has(file))) omit.add(item.item_id);
      return store.claimsPerSeat(board, perSeat, { runs: store.boardRunsReader(board, ctx.file) }).n - heldTop(ctx, board).length;
    });
    if (room <= 0) break;
    const found = await nextOnce(ctx, { ...values, build: true, omitIds: [...omit] });
    if (found.skipItem) { omit.add(found.skipItem); continue; }
    if (!found.item || found.held || found.review || found.waitingOffer || found.retry || !found.itemFolder) break;
    omit.add(found.item.item_id);
    taken.push(found);
  }
  return taken;
}
