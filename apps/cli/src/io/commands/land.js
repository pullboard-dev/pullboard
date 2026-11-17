import { replayLanding } from '../../../../../packages/landing/index.js';
import { replayLine } from '../../../../../packages/landing/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { automaticLandingEnabled } from '../../../../../packages/merge/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { requireManualLanding } from '../../../../../packages/merge/index.js';
import { badgeCounts } from '../../../../view/index.js';
import { badgeDocuments } from '../../../../view/index.js';
import { pairPrefix } from '../../../../../packages/flakes/index.js';
import { quarantineWaivers } from '../../../../../packages/flakes/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
/** The pullboard land command, in its own module so an item adding another command never edits these lines. */
import { landWhy } from '../../../../../packages/landing/index.js';
import { landWhyLines } from '../../../../../packages/landing/index.js';
import { landOneByHand as landItemByHand } from '../../../../../packages/landing/index.js';
import { heldTestDefects } from '../../../../../packages/landing/index.js';
import { withBoardRead } from '../board/read.js';
import { landingWaits } from '../landing/waiting.js';
import { landingWaitLine } from '../landing/waiting.js';
import { context } from '../read.js';
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
  loadMachineSettings,
} from '../../../../../packages/config/index.js';
import {
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  requireSignedPerson,
} from '../../../../../packages/person/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  actOn,
  ordered,
} from '../entry.js';

/** Run `pullboard land` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values.why) {
    const ctx = context(io);
    const why = await withBoardRead(ctx, (board) => landWhy(board, ctx.clock.now()));
    if (values.json) io.result(why);
    else for (const line of landWhyLines(why)) io.say(line);
    return 0;
  }
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  if (values.replay) {
    if (first || second || rest.length || values.due || values.adopt || values['dry-run'] || values.waive !== undefined || values.max !== undefined) throw new Refused('USAGE', 'pullboard land --replay [--since <time>] takes no other option');
    const rows = replayLanding(board, { since: values.since });
    io.result?.({ replay: rows });
    for (const row of rows) io.say(replayLine(row));
    if (!rows.length) io.say('no recorded landing batches to replay');
    return 0;
  }
  if (values.item !== undefined) return landOneByHand(ctx, board, me, values);
  if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator lands verified batches; ask your coordinator to run pullboard land');
  if (values.forced !== undefined) return offerForcedLanding(ctx, io, board, [first, second, ...rest], values);
  if (values.waive !== undefined) {
    if (first || second || rest.length || values.due || values.adopt || values.max !== undefined) throw new Refused('USAGE', 'pullboard land --waive <test> --until <date> --reason <why>');
    const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'land-waive', args: { waive: String(values.waive), until: String(values.until ?? ''), reason: String(values.reason ?? '') } });
    if (confirmed !== null) return confirmed;
    requirePersonChannel(io.personChannel);
    const waiver = await ordered(ctx, board, 'recordLandingWaiver', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal',
      id: randomUUID(), test: values.waive, until: values.until, reason: values.reason }]);
    io.result?.({ batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], waiver });
    io.say(`waived ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test} until ${waiver.until}: ${waiver.reason}`);
    return 0;
  }
  // The land job is the one landing path: land offers it and runs no batch on this host (lander v2 section 3) [#6119].
  const batchOption = ['items', 'commit', 'dry-run', 'adopt', 'due', 'max', 'until', 'reason'].find(name => values[name] !== undefined && values[name] !== false);
  if (first || second || rest.length || batchOption) throw new Refused('LAND_OFFER_ONLY', `pullboard land only offers the land job${batchOption ? `; --${batchOption} ran the retired host batch` : ''}`, 'run pullboard land with no option, or land <id> --forced "<why>"');
  try { requireManualLanding(mainPolicy(ctx.info.root).config); } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'BOARD_LANDS_ACCEPTED') throw error;
    const waits = landingWaits(board.db, store.listItems(board, { all: true }), ctx.clock.now().getTime());
    // An accepted item no land job names would wait for good, so land offers its job as the accept should have (#7948).
    if (!waits.some(wait => wait.state === 'none')) {
      // A 0.9.3 user ran land by hand; say what changed, where each accepted item waits, and the one setting that brings it back.
      throw new Refused('BOARD_LANDS_ACCEPTED', `the board lands accepted items by itself: once an item is accepted, landing starts on its own, so pullboard land is no longer needed by hand${waits.length ? `; ${waits.map(landingWaitLine).join('; ')}` : ''}`, 'to land by hand as before, set landing.manualOverride to true in pullboard.json (the person sets it); otherwise run pullboard next for other work');
    }
    io.say(`no land job names ${waits.filter(wait => wait.state === 'none').map(wait => `#${wait.id}`).join(' ')}; offering it now, as its accept should have`);
  }
  const offered = await offerLanding(ctx, ctx.info.root, { board });
  if (!offered) throw noLandingRunner();
  io.result?.(offered);
  if (!offered.offered) io.say('no verified items ready to land');
  return 0;
});
}

/**
 * `pullboard land --item <id> --reason "<why>"`: lands one accepted item by hand through the landing package (#9569, #9571), after the refusals that guard it.
 * Off by default, because the board lands accepted items by itself once landing.byHand is not set.
 */
function landOneByHand(ctx, board, me, values) {
  if (loadMachineSettings().landing?.byHand !== true) throw new Refused('BY_HAND_OFF', 'landing one item by hand is off: the board lands accepted items by itself', 'the person sets landing.byHand to true in the machine settings to land by hand; otherwise run pullboard next for other work');
  if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator lands an item by hand', 'ask your coordinator to run pullboard land --item <id>');
  const id = String(values.item);
  if (!/^[1-9][0-9]*$/u.test(id)) throw new Refused('USAGE', `--item takes an item number, not "${id}"`, 'pullboard land --item <id>');
  const item = store.getItem(board, Number(id));
  if (!item || item.item_status !== 'verified' || item.item_merged_commit) throw new Refused('NOT_ACCEPTED', `#${id} is not an accepted item waiting to land${item ? ` (${item.item_status}${item.item_merged_commit ? ', already landed' : ''})` : ''}`, `wait for a reviewer to accept #${id}: pullboard show ${id}`);
  const reason = String(values.reason ?? '').trim();
  if (!reason) throw new Refused('HAND_REASON', 'landing by hand names why: pass a reason', `pullboard land --item ${id} --reason "<why>"`);
  const trunk = mainCheckout(ctx.info.root);
  // The hold is read on the checked-out trunk, as the automatic landing reads it; a waived defect still counts here, so the record names it.
  const held = trunk ? heldTestDefects(ctx.info.root, board, { branch: trunk.branch, commit: trunk.commit }) : [];
  const landed = landItemByHand(board, Number(id), { root: ctx.info.root, reason, held, agentId: me.id });
  ctx.io.result?.(landed);
  ctx.io.say?.(`#${id} landed by hand as ${landed.commit.slice(0, 12)}: ${landed.reason}; bypassed hold: ${landed.hold}`);
  return 0;
}

/** The refusal when no runner can take a land job: no trunk remote of record and no local runner on this machine. */
function noLandingRunner() {
  return new Refused('LAND_NO_RUNNER', 'a landing is a runner land job, and this board has no trunk remote of record and no local runner under pull dispatch', 'set trunk.remote in pullboard.json to the trunk\'s git URL, or use pull dispatch with gate.localRunner on in the machine settings');
}

/** Offer a runner land job from the main checkout (pull.js's offerPulledLanding), loaded only when a landing is offered. */
async function offerLanding(ctx, root, options = {}) {
  return (await import('../landing/pull.js')).offerPulledLanding(ctx, root, { mainPolicy, pairPrefix, quarantineWaivers, gateRuns, listItems: store.listItems, checkedLandingCommit: store.checkedLandingCommit, badgeDocuments: board => badgeDocuments(badgeCounts(board)) }, options);
}

/**
 * `pullboard land <id>... --forced "<why>"`: offer the named items as the same land job kind as any landing, carrying
 * the forced reason, so a forced landing goes through the runner's merge, check and receipt-guarded push (#5864).
 */
async function offerForcedLanding(ctx, io, board, args, values) {
  const forced = String(values.forced ?? '').trim();
  const ids = args.filter(arg => arg !== undefined && arg !== null);
  if (!forced) throw new Refused('FORCED_REASON', 'a forced landing names why it went around the gate: --forced "<why>"');
  if (!ids.length || ids.some(id => !/^[1-9][0-9]*$/u.test(String(id)))) throw new Refused('USAGE', 'pullboard land <id> [<id>...] --forced "<why>"');
  const offered = await offerLanding(ctx, primaryCheckoutRoot(ctx.info), { ids: ids.map(Number), forced, board });
  if (!offered) throw noLandingRunner();
  io.result?.(offered);
  return 0;
}

/**
 * Offer the land job after acceptance; the caller catches this entire post-verdict effect. A runner merges and pushes,
 * so no session on this host lands anything (#2499). Returns the offer, or false (with the next step said) when
 * automatic landing is off or no runner can take the job [#6119].
 */
export async function landAfterAcceptance(ctx) {
  if (!mainCheckout(ctx.info.root)?.branch || !automaticLandingEnabled(mainPolicy(ctx.info.root).config)) return false;
  const root = primaryCheckoutRoot(ctx.info);
  // A runner lands, in any dispatch mode: this host offers one land job row and returns, and runs no batch [P7,#5864,#6119].
  const pulled = await offerLanding(ctx, root);
  if (pulled) return pulled;
  const refusal = noLandingRunner();
  ctx.io.say?.(`not landed: ${refusal.message}; next: ${refusal.next}`);
  return false;
}
