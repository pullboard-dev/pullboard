import { requireLandingCompanions } from '../../../../../packages/landing/index.js';
import { requireLandingModuleResolution } from '../../../../../packages/landing/index.js';
/** The pullboard merged command, in its own module so an item adding another command never edits these lines. */
import { warnMainMoved } from '../../../../../packages/merge/index.js';
import * as store from '../../../../../packages/store/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { prepareTrainLanding } from '../../../../../packages/landing/index.js';
import { smokeCommit } from '../../../../../packages/landing/index.js';
import { landingPlanCheck } from '../../../../../packages/landing/index.js';
import { recordLandingAudit } from '../../../../../packages/landing/index.js';
import { refreshEnvironment } from '../../../../../packages/landing/index.js';
import { startDetachedCheck } from '../../../../../packages/drive/index.js';
import { fileURLToPath } from 'node:url';
import { landingFlakeRatchet } from '../../../../../packages/flakes/index.js';
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { landMerged } from '../../../../../packages/land/index.js';
import {
  codeIsFromMain,
  contains,
  mainCheckout,
  patchId,
  resolveCommit,
  tryGit,
} from '../../../../../packages/git/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../../../../../packages/link/index.js';
import {
  actOn,
  idArg,
  ordered,
  primaryCheckoutRoot,
  textArg,
} from '../entry.js';

/**
 * The existing record when the item is already merged: the same commit is a no-op naming it, a different one is refused
 * naming both. Why: a hand-landing loop retried after a lost reply and appended a second merged event for five items [C7].
 * The check lives in the command, not the move, so replaying the older doubled events still reproduces them.
 *
 * @param {{ item_id: number, item_merged_commit?: string | null }} item
 * @param {string} commit
 * @returns {{ commit: string } | null}
 */
export function recordedMerge(item, commit) {
  const recorded = item.item_merged_commit;
  if (!recorded) return null;
  if (recorded === commit) return { commit: recorded };
  throw new Refused('MERGED_ALREADY', `item #${item.item_id} is already merged as ${recorded}; ${commit} is a different commit, so nothing was recorded`);
}

/** Refresh the derived map after the merged receipt has been recorded. */
async function refreshMap(ctx, io, board, trunk) {
  const root = primaryCheckoutRoot(ctx.info);
  if (!root) return;
  try {
    await warnMainMoved({ root, board, trunk, write: (operation, args) => ordered(ctx, board, operation, args), say: text => io.say(text) }, { listAgents: store.listAgents, listItems: store.listItems });
  } catch (error) { io.say('main-move warnings deferred: ' + error.message); }
  try {
    const { refreshLandedCodeMap } = await import('../../../../../packages/codemap/index.js');
    const map = refreshLandedCodeMap(root);
    if (map) io.say(`code map refreshed for main ${map.mainCommit.slice(0, 12)}`);
  } catch (error) {
    io.say(`code map refresh deferred: ${error.message}`);
  }
}

/**
 * Refuse a hand merge of a verified item unless its commit is on trunk and carries the item's work, as today.
 *
 * @param {object} ctx
 * @param {object} io
 * @param {object} board
 * @param {Record<string, any>} values
 * @param {number} id
 * @param {string} commit
 * @param {{ deferred?: boolean }} [options] - deferred: the commit is on main, so the module scan runs after the record.
 * @returns {Promise<void>}
 */
async function requireMergedOnTrunk(ctx, io, board, values, id, commit, { deferred = false } = {}) {
  const note = (textArg(io, values, 'note') ?? '').trim();
  const item = store.getItem(board, id);
  if (values.forced !== undefined) {
    // A forced landing skips the verify, never the trunk: its commit must be on the primary trunk.
    const onTrunk = mainCheckout(ctx.info.root);
    if (!(onTrunk?.commit && contains(ctx.info.root, commit, onTrunk.commit))) {
      throw new Refused('NOT_MERGED', `commit ${commit} is not on trunk ${onTrunk?.branch ?? 'the unavailable primary trunk'}${onTrunk?.commit ? ` at ${onTrunk.commit}` : ''}; a forced merge records only a commit that is on main`);
    }
    return;
  }
  if (item.item_status !== 'verified') return;
  requireLandingCompanions(ctx.info.root, board, [item], commit);
  if (!deferred) {
    const moduleBase = tryGit(ctx.info.root, ['rev-parse', '--verify', `${commit}^`]);
    if (moduleBase.status !== 0) throw new Refused('LAND_MODULE_SOURCE', 'restore the landing parent before recording its source checks');
    await requireLandingModuleResolution(ctx.info.root, moduleBase.stdout, commit);
  }
  const trunk = mainCheckout(ctx.info.root);
  const itemCommit = item.item_commit;
  const itemOnCandidate = contains(ctx.info.root, itemCommit, commit);
  const candidateOnTrunk = Boolean(trunk?.commit && contains(ctx.info.root, commit, trunk.commit));
  const parent = tryGit(ctx.info.root, ['rev-parse', '--verify', '--quiet', `${commit}^`]);
  const itemPatch = item.item_claim_head ? patchId(ctx.info.root, item.item_claim_head, itemCommit) : null;
  const candidatePatch = parent.status === 0 ? patchId(ctx.info.root, parent.stdout, commit) : null;
  const carriesPatch = Boolean(itemPatch && candidatePatch && itemPatch === candidatePatch);
  if (!note && !(candidateOnTrunk && (itemOnCandidate || carriesPatch))) {
    const trunkName = trunk?.branch ?? 'the unavailable primary trunk';
    const trunkAt = trunk?.commit ? ` at ${trunk.commit}` : '';
    throw new Refused('NOT_MERGED', `commit ${commit} is not on trunk ${trunkName}${trunkAt}, or does not contain item commit ${itemCommit} or carry its patch; merge that work onto ${trunkName}, or use --note "why"`);
  }
}

/** Run `pullboard merged` and return its exit code. */
export async function run(io, { first, second, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    const train = recovered.move.operation === 'recordTrainLanding' ? recovered.move.args[0] : null;
    const commit = train ? train.batch.tip : recovered.move.args[1].commit;
    const ids = train ? train.batch.items.map(item => item.id) : [idArg(first)];
    io.result?.({ id: idArg(first), commit, ...(train ? { ids, batch: train.batch.id, receiptId: train.receipt.id } : {}) });
    io.say(`${ids.map(id => `#${id}`).join(', ')} merged as ${commit.slice(0, 12)}`);
    await refreshMap(ctx, io, board, commit);
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
    return 0;
  }
  const commit = resolveCommit(ctx.info.root, second ?? '');
  if (!commit) throw new Refused('NO_COMMIT', `no commit "${second ?? ''}" in this repo`);
  const id = idArg(first);
  const existing = recordedMerge(store.getItem(board, id), commit);
  if (existing) {
    io.result?.({ id, commit: existing.commit, already: true });
    io.say(`#${first} is already merged as ${existing.commit.slice(0, 12)}; nothing recorded`);
    return 0;
  }
  if (values.forced !== undefined && !String(values.forced).trim()) throw new Refused('FORCED_REASON', 'a forced merge names why it went around the gate: --forced "<why>"');
  const train = values['gate-receipt'] !== undefined || mainPolicy(ctx.info.root).config.landing?.requireReceipts === true;
  const ids = train && values.items !== undefined ? String(values.items).split(',').map(value => idArg(value.trim())) : [id];
  const parent = tryGit(ctx.info.root, ['rev-parse', '--verify', '--quiet', `${commit}^`]);
  let request = null;
  /** Prepare the train envelope; select checks it before anything is written, and a resumed record rebuilds it. */
  const prepare = () => {
    request = prepareTrainLanding(ctx.info.root, board, ids, commit, values['gate-receipt']);
    request.batch.flakeRatchet = landingFlakeRatchet(board).snapshot;
    return request;
  };
  // A commit already on main, or a forced merge, is recorded first: the plan check, the smoke, the module scan and the
  // cells placement run after the record in a detached follow-up, and a forced merge runs no checks (9 Nov: 15+ min) [C7].
  const trunkTip = train ? null : mainCheckout(ctx.info.root)?.commit;
  const deferred = !train && (values.forced !== undefined || Boolean(trunkTip && contains(ctx.info.root, commit, trunkTip)));
  /** The hand landing's checks, in today's order; any refusal leaves the landing job without steps. */
  const check = async () => {
    if (!deferred) {
      await landingPlanCheck(ctx.info.root, commit);
      // A hand landing never crosses the landing gate, so it gets the same scratch-board smoke before anything is recorded [C7].
      await smokeCommit(ctx.info.root, commit);
    }
    if (train) {
      if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the primary coordinator records a train envelope');
      if (!ids.includes(id)) throw new Refused('USAGE', '--items must include the first named item');
      prepare();
      return { train: true };
    }
    await requireMergedOnTrunk(ctx, io, board, values, id, commit, { deferred });
    // The store's own refusals, checked before any step is written so a refused merge writes no tooling pin.
    store.coordinatorOnly(me.id, 'records merges');
    const item = store.getItem(board, id);
    if (values.forced === undefined && item.item_status !== 'verified' && item.item_merged_commit !== commit) {
      throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; merge verified work only`);
    }
    return { train: false };
  };
  /** Record the merge on the board once: a rerun after a recorded merge writes nothing new. */
  const record = async () => {
    if (ids.every(value => store.getItem(board, value)?.item_merged_commit === commit)) return { already: true };
    if (train) {
      if (!request) prepare();
      if (codeIsFromMain()) {
        const afterEventId = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
        await (await import('../../../../../packages/gate/index.js')).activateMainAudits(ctx.info.root, afterEventId, store.boardId(board));
      }
      const batch = await ordered(ctx, board, 'recordTrainLanding', [request]);
      return { batch: batch.id, receiptId: request.receipt.id };
    }
    const note = (textArg(io, values, 'note') ?? '').trim();
    const flakeRatchet = landingFlakeRatchet(board).snapshot;
    await ordered(ctx, board, 'merged', [id, { agentId: me.id, commit, note, flakeRatchet, ...(values.forced === undefined ? {} : { forced: values.forced }), ...(values['waive-proof'] === undefined ? {} : { waiveProof: values['waive-proof'] }) }]);
    return {};
  };
  let announced = false;
  /** Say what was recorded, once per run, from the record step's saved payload. */
  const announce = (written = {}) => {
    announced = true;
    if (train) io.result?.({ id, ids, commit, ...(written.batch ? { batch: written.batch, receiptId: written.receiptId } : {}) });
    else io.result?.({ id: idArg(first), commit });
    io.say(train ? `${ids.map(value => `#${value}`).join(', ')} merged as ${commit.slice(0, 12)}` : `#${first} merged as ${commit.slice(0, 12)}`);
  };
  /** Publish: today's output, then the derived map refresh. */
  const publish = async ({ written }) => {
    announce(written.record);
    if (!written.record?.already) for (const itemId of ids) recordLandingAudit(board, itemId, commit, me.id);
    if (deferred && !written.record?.already) {
      // Detached, with no checkout lease token or agent session id, so the follow-up never holds or waits on the checkout.
      const started = startDetachedCheck(fileURLToPath(new URL('../../../../../packages/landing/src/io/merged/scripts/followup.js', import.meta.url)),
        { args: [ctx.info.root, commit, ...(values.forced === undefined ? [] : ['--forced'])], cwd: ctx.info.root, env: refreshEnvironment() });
      if (started !== null) io.say('checks run after the record; see merged-checks.log in the machine\'s pullboard home');
    }
    await refreshMap(ctx, io, board, commit);
    return { map: true };
  };
  const landed = await landMerged(board.db, { repo: ctx.info.root, ids, commit, base: parent.status === 0 ? parent.stdout : undefined,
    owner: `merged:${me.id}`, check, record, publish });
  if (!announced) announce(landed.written.record);
  return 0;
});
}
