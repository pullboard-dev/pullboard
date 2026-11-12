/**
 * The work a hand landing's `pullboard merged` does after its record, for a commit already on main [C7].
 *
 * Why: the record waited behind a scratch-board smoke and a plan check on a runner, a module-resolution scan of the
 * whole tree (10 s) and placing new files in the cells plan (7 s). On 9 Nov each `merged` took 15+ minutes and held
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
import { placeLandingNewFiles } from '../history.js';

/**
 * Place the files a hand landing added that the cells plan does not cover, as one chore commit on the checkout, so the
 * landing never leaves main's cells-plan check red (#3443). It acts only when the landing is that checkout's tip on a
 * clean tree; anything else leaves the checkout as it is.
 *
 * @param {string} root The checkout `pullboard merged` runs in.
 * @param {string} commit The landing commit being recorded.
 * @param {(text: string) => void} say
 */
export function placeUncoveredOnTrunk(root, commit, say) {
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  const dirty = tryGit(root, ['status', '--porcelain']);
  if (head.status !== 0 || head.stdout.trim() !== commit || dirty.status !== 0 || dirty.stdout.trim()) return;
  const files = placeLandingNewFiles(root);
  if (!files.length) return;
  const added = tryGit(root, ['add', '--', ...files]);
  const made = added.status === 0 ? tryGit(root, ['commit', '-q', '-m', 'chore(cells): place new files in the plan [C7]']) : added;
  if (made.status === 0) say(`placed new files in the cells plan: ${tryGit(root, ['rev-parse', '--short=12', 'HEAD']).stdout.trim()}`);
  else tryGit(root, ['reset', '-q', '--hard', commit]);
}

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
 * Run a recorded hand landing's follow-up: place uncovered files, then, unless forced, the plan check, the smoke and
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
  await step('place new files', () => placeUncoveredOnTrunk(root, commit, say));
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
