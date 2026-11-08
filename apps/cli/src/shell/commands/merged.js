import { requireLandingCompanions } from '../../../../../packages/landing/index.js';
import { requireLandingModuleResolution } from '../../../../../packages/landing/index.js';
/** The pullboard merged command, in its own module so an item adding another command never edits these lines. */
import { warnMainMoved } from '../../../../../packages/merge/index.js';
import * as store from '../../../../../packages/store/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { prepareTrainLanding } from '../../../../../packages/landing/index.js';
import { runCommitCliSmoke } from '../../../../../packages/landing/index.js';
import { requireLandingPlanCheck } from '../../../../../packages/landing/index.js';
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
} from '../cli.js';

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
 * @returns {Promise<void>}
 */
async function requireMergedOnTrunk(ctx, io, board, values, id, commit) {
  const note = (textArg(io, values, 'note') ?? '').trim();
  const item = store.getItem(board, id);
  if (item.item_status !== 'verified') return;
  requireLandingCompanions(ctx.info.root, board, [item], commit);
  const moduleBase = tryGit(ctx.info.root, ['rev-parse', '--verify', `${commit}^`]);
  if (moduleBase.status !== 0) throw new Refused('LAND_MODULE_SOURCE', 'restore the landing parent before recording its source checks');
  await requireLandingModuleResolution(ctx.info.root, moduleBase.stdout, commit);
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
  /** The hand landing's checks, in today's order; any refusal leaves the landing job without steps. */
  const check = async () => {
    requireLandingPlanCheck(ctx.info.root, commit);
    // A hand landing never crosses the landing gate, so it gets the same scratch-board smoke before anything is recorded [C7].
    runCommitCliSmoke(ctx.info.root, commit);
    if (train) {
      if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the primary coordinator records a train envelope');
      if (!ids.includes(id)) throw new Refused('USAGE', '--items must include the first named item');
      prepare();
      return { train: true };
    }
    await requireMergedOnTrunk(ctx, io, board, values, id, commit);
    // The store's own refusals, checked before any step is written so a refused merge writes no tooling pin.
    store.coordinatorOnly(me.id, 'records merges');
    const item = store.getItem(board, id);
    if (item.item_status !== 'verified' && item.item_merged_commit !== commit) {
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
    await ordered(ctx, board, 'merged', [id, { agentId: me.id, commit, note, flakeRatchet }]);
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
    await refreshMap(ctx, io, board, commit);
    return { map: true };
  };
  const landed = await landMerged(board.db, { repo: ctx.info.root, ids, commit, base: parent.status === 0 ? parent.stdout : undefined,
    owner: `merged:${me.id}`, check, record, publish });
  if (!announced) announce(landed.written.record);
  return 0;
});
}
