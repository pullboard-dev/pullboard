/**
 * The work a hand landing's `pullboard merged` does after its record, for a commit already on main [C7].
 *
 * Why: the record waited behind a scratch-board smoke and a check on a runner, a module-resolution scan of the
 * whole tree (10 s). On 9 Nov each `merged` took 15+ minutes and held
 * up the hand landings after it. A commit already on main is landed whatever these say, so they run after the record,
 * in a detached child (packages/landing/src/io/merged/scripts/followup.js) that logs to the machine's merged-checks.log; a forced merge runs no
 * checks at all.
 */
import { join } from 'node:path';
import { tryGit } from '../../../../git/index.js';
import { logEvent } from '../../../../store/index.js';
import { proofReceipts } from '../../../../store/index.js';
import { machineHome } from '../../../../resources/index.js';
import { requireLandingModuleResolution } from '../guards.js';
import { smokeCommit } from '../smoke.js';
import { landingPlanCheck } from '../plan/check.js';

/**
 * The post-landing audit as a board job: after a landing is recorded it writes one proof-run of kind audit naming the
 * item and the landed commit (and the item's tip), unasked, so the audit no longer lives in a census script's free text [#4743].
 * It is idempotent: the receipt id is fixed by item and landed commit, so a replayed landing records it once.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} commit The landed commit.
 * @param {string} agentId The seat that recorded the landing.
 * @returns {string | null} The audit receipt id, or null when one already exists.
 */
export function recordLandingAudit(board, id, commit, agentId) {
  const receiptId = `audit:${id}:${commit.slice(0, 12)}`;
  if (proofReceipts(board, id).some(run => run.id === receiptId)) return null;
  const item = board.db.prepare('SELECT item_commit FROM item WHERE item_id = ?').get(id);
  logEvent(board, agentId, 'proof-run', id, { receipt: { id: receiptId, kind: 'audit', item: id, commit, itemTip: item?.item_commit ?? null, exitCode: 0 } });
  return receiptId;
}

/**
 * Run a recorded hand landing's follow-up: the engine check, the smoke and
 * the module-resolution scan. Each outcome is said; a red one names its refusal code, so the audit can file it.
 *
 * @param {string} root
 * @param {string} commit
 * @param {{ forced?: boolean, say: (text: string) => void }} options
 * @returns {Promise<{ red: string[] }>}
 */
export async function runMergedFollowup(root, commit, { forced = false, say }) {
  const red = [];
  const step = async (name, work) => {
    const started = performance.now();
    try { await work(); say(`${name} ok in ${Math.round(performance.now() - started)} ms`); }
    catch (error) { red.push(name); say(`${name} red in ${Math.round(performance.now() - started)} ms: [${error?.code ?? 'ERROR'}] ${String(error?.message ?? error).slice(0, 300)}`); }
  };
  if (forced) { say('checks skipped: forced'); return { red }; }
  await step('plan check', () => landingPlanCheck(root, commit));
  await step('smoke', () => smokeCommit(root, commit));
  const parent = tryGit(root, ['rev-parse', '--verify', '--quiet', `${commit}^`]);
  if (parent.status === 0) await step('module resolution', () => requireLandingModuleResolution(root, parent.stdout.trim(), commit));
  return { red };
}

/** The log a follow-up writes: merged-checks.log in the machine's pullboard home. */
export function mergedChecksLog() {
  return join(machineHome(), 'merged-checks.log');
}
