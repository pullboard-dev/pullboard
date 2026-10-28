/** The pullboard merged command, in its own module so an item adding another command never edits these lines. */
import { warnMainMoved } from '../main-moved-warning.js';
import * as store from '../board.js';
import {
  contains,
  mainCheckout,
  patchId,
  resolveCommit,
  tryGit,
} from '../git.js';
import {
  Refused,
} from '../refused.js';
import {
  relayCommandReceipt,
  relayCommandReceiptReported,
} from '../relay.js';
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
    await warnMainMoved({ root, board, trunk, write: (operation, args) => ordered(ctx, board, operation, args), say: text => io.say(text) });
  } catch (error) { io.say('main-move warnings deferred: ' + error.message); }
  try {
    const { refreshLandedCodeMap } = await import('../code-map.js');
    const map = refreshLandedCodeMap(root);
    if (map) io.say(`code map refreshed for main ${map.mainCommit.slice(0, 12)}`);
  } catch (error) {
    io.say(`code map refresh deferred: ${error.message}`);
  }
}

/** Run `pullboard merged` and return its exit code. */
export async function run(io, { first, second, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
  if (recovered) {
    io.recordedMove = true;
    for (const event of recovered.events) io.onEvent?.(event);
    const commit = recovered.move.args[1].commit;
    io.result?.({ id: idArg(first), commit });
    io.say(`#${first} merged as ${commit.slice(0, 12)}`);
    await refreshMap(ctx, io, board, commit);
    await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
    return 0;
  }
  const commit = resolveCommit(ctx.info.root, second ?? '');
  if (!commit) throw new Refused('NO_COMMIT', `no commit "${second ?? ''}" in this repo`);
  const id = idArg(first);
  const note = (textArg(io, values, 'note') ?? '').trim();
  const item = store.getItem(board, id);
  if (item.item_status === 'verified') {
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
  await ordered(ctx, board, 'merged', [id, { agentId: me.id, commit, note }]);
  io.result?.({ id: idArg(first), commit });
  io.say(`#${first} merged as ${commit.slice(0, 12)}`);
  await refreshMap(ctx, io, board, commit);
  return 0;
});
}
