/** A fresh seat's resume adopts the claim an orphaned seat left behind, from the ref that pinned its work [C7]. */
import { existsSync } from 'node:fs';
import { tryGit } from '../../../../../packages/git/index.js';
import { itemsInStatus } from '../../../../../packages/store/index.js';
import * as store from '../../../../../packages/store/index.js';
import { ordered } from '../entry.js';
import { whoAmI } from '../entry.js';
import { withBoardRead } from '../board/read.js';

/**
 * The newest handoff pin of an item and the head it names, or null when the repository holds none.
 *
 * @param {string} root the repository to read refs from
 * @param {number} itemId
 * @returns {{ pin: string, head: string } | null}
 */
function newestPin(root, itemId) {
  const refs = tryGit(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname) %(objectname)', `refs/pullboard/handoffs/${itemId}/`]);
  const [pin, head] = refs.status === 0 ? (refs.stdout.split('\n')[0] ?? '').split(' ') : [];
  return pin && head ? { pin, head } : null;
}

/**
 * Merge the newest handoff pin of an item into a folder: returns its pin and head, or null with the folder left clean
 * when no pin exists or the merge conflicts.
 * Why: only resume adopted pinned work, so the pin lookup and merge were buried in its one caller (#9688).
 *
 * @param {string} root the repository to read refs from
 * @param {string} folder the item folder to merge the pin into
 * @param {number} itemId
 * @returns {{ pin: string, head: string } | null}
 */
export function adoptPinnedHead(root, folder, itemId) {
  const found = newestPin(root, itemId);
  if (!found) return null;
  const merged = tryGit(folder, ['merge', '--no-edit', found.pin]);
  if (merged.status !== 0) { tryGit(folder, ['merge', '--abort']); return null; }
  return found;
}

/**
 * The open item in this lane whose last holder's seat folder is gone and whose work is pinned under refs/pullboard/handoffs.
 *
 * Why: a reboot or a cleaned folder strands a claim with its commits still in the shared repository; the pin names them.
 *
 * @param {any} board
 * @param {any} me the resuming seat
 * @param {string} root the repository to read refs from
 * @returns {{ id: number, holder: string, pin: string, head: string } | null}
 */
export function orphanedClaim(board, me, root) {
  for (const item of store.listItems(board, { all: true })) {
    if (item.item_status !== 'open' || item.item_lane !== me.lane) continue;
    const claimed = store.events(board, { itemId: item.item_id }).filter(event => event.event_kind === 'claim').at(-1);
    const holder = claimed ? store.agentById(board, claimed.event_by) : null;
    if (!holder || holder.agent_id === me.id || (holder.agent_path && existsSync(holder.agent_path))) continue;
    const pinned = newestPin(root, item.item_id);
    if (pinned) return { id: item.item_id, holder: holder.agent_id, ...pinned };
  }
  return null;
}

/**
 * Claim the orphaned item, bring its pinned head into the new item folder, and credit the seat that built it.
 * Runs only when `resume.adoptOrphans` is on and the seat holds nothing.
 *
 * @param {any} io
 * @param {any} ctx
 * @returns {Promise<{ id: number, holder: string, head: string } | null>} what was adopted, or null
 */
export async function adoptOrphanedClaim(io, ctx) {
  if (ctx.config.resume?.adoptOrphans !== true || ctx.info.isMain) return null;
  const found = await withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    return me.id === 'coordinator' || itemsInStatus(board, 'claimed', me.id).length ? null : orphanedClaim(board, me, ctx.info.root);
  });
  if (!found) return null;
  let folder = null;
  const quiet = Object.create(io);
  quiet.say = () => {};
  quiet.result = result => { folder = result.itemFolder ?? null; };
  const { run } = await import('../commands/claim.js');
  if (await run(quiet, { first: String(found.id) }) !== 0 || typeof folder !== 'string') return null;
  if (!adoptPinnedHead(ctx.info.root, folder, found.id)) return null;
  await (await import('../board/access.js')).actOn(io, (c, board, me) => ordered(c, board, 'appendFact', [found.id, { agentId: me.id, kind: 'note',
    text: `Adopted the orphaned claim of ${found.holder} from ${found.pin}; head ${found.head.slice(0, 12)} restored, credit to ${found.holder}.`, ref: null }]));
  io.say(`adopted #${found.id} from ${found.holder}: head ${found.head.slice(0, 12)} restored from ${found.pin}`);
  return found;
}

/**
 * Bring the pinned head of a returned item's earlier work into the folder next --take just claimed, and credit the seat that built it.
 * Why: a released item kept its commits under refs/pullboard/handoffs but its next claimant started from main (#9689, after #2481).
 * A merge conflict leaves the folder as claimed and says so.
 *
 * @param {any} io
 * @param {any} ctx
 * @param {number} itemId
 * @param {string} folder the item folder the claim just opened
 * @returns {Promise<{ pin: string, head: string } | null>} what was restored, or null
 */
export async function adoptReturnedWork(io, ctx, itemId, folder) {
  if (!newestPin(ctx.info.root, itemId)) return null;
  const found = adoptPinnedHead(ctx.info.root, folder, itemId);
  if (!found) { io.say(`pinned work of #${itemId} conflicts with main: the item folder stays as claimed`); return null; }
  const holder = await withBoardRead(ctx, board => {
    const claims = store.events(board, { itemId }).filter(event => event.event_kind === 'claim');
    return claims.length > 1 ? claims.at(-2).event_by : null;
  });
  await (await import('../board/access.js')).actOn(io, (c, board, me) => ordered(c, board, 'appendFact', [itemId, { agentId: me.id, kind: 'note',
    text: `Adopted the orphaned claim of ${holder ?? 'its earlier seat'} from ${found.pin}; head ${found.head.slice(0, 12)} restored${holder ? `, credit to ${holder}` : ''}.`, ref: null }]));
  io.say(`restored the pinned work of #${itemId}: head ${found.head.slice(0, 12)} from ${found.pin}`);
  return found;
}
