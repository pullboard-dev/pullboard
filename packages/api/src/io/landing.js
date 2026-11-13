/** The board side of a runner landing job: one queue row naming the accepted items and the trunk sha expected [P7]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { ledgerFiles } from '../../../store/index.js';
import { ledgerHits } from '../../../store/index.js';
import { ledgerMainReds } from '../../../store/index.js';
import { offerJob } from './jobs.js';

/** The job kind a runner asks for to take landings; packages/landing's runner side takes this kind. */
export const LANDING_JOB_KIND = 'land';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const REF = /^refs\/[A-Za-z0-9._/-]{1,200}$/u;

/** Refuse an accepted-items list a runner could not land as written; return it in landing order. */
function landingItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Refused('LANDING_ITEMS', 'a landing job names at least one accepted item as { id, commit, ref? }');
  return items.map(entry => {
    if (!Number.isSafeInteger(entry?.id) || entry.id < 1 || !SHA.test(entry.commit ?? '') || (entry.ref !== undefined && !REF.test(entry.ref))) {
      throw new Refused('LANDING_ITEMS', 'each landed item is { id, commit, ref? }: a positive item id, its full accepted commit sha, and the refs/ name the trunk remote holds it under');
    }
    return { id: entry.id, commit: entry.commit, ...(entry.ref ? { ref: entry.ref } : {}) };
  });
}

/**
 * Offer one landing to the runners: a row on the board's job queue, never a process on this host. The row carries the
 * accepted items, the trunk sha they were accepted against and the trunk remote of record; a runner fetches, merges,
 * checks and pushes. Offering the same landing again returns the job as it stands.
 *
 * Why: the board host only keeps rows, so a landing survives the board host sleeping, and nothing here runs git.
 * One job kind for every landing: automatic on accept, by hand, and forced, whatever gate.runnerDispatch says (#5864).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ items: { id: number, commit: string, ref?: string }[], expect: string, config: { trunk?: { remote?: string }, landing?: { trunkRemote?: string } },
 *   mode?: string, trunk?: string, check?: string[] | null, needs?: string[], checkout?: boolean, forced?: string | null, badges?: { path: string, text: string }[], now?: number }} request - badges: the
 *   badge documents the board computed, which the runner writes into the landing merge (it has no board) [C7]; checkout: the
 *   remote is the board host's own checkout with trunk checked out, so the push updates its work tree too [P7]; forced: the
 *   reason a forced landing names, carried on the job and its key, and its job runs no check; mode is no longer read, since landing
 *   pulls in any mode. config.landing.publish "separate" rides on the job, so a red item parks and the clean ones land.
 * @returns {ReturnType<typeof offerJob>}
 */
export function offerLandingJob(db, { items, expect, config, trunk = 'refs/heads/main', check = null, needs = [], checkout = false, forced = null, badges = [], now = Date.now() }) {
  // trunk.remote, else its old name landing.trunkRemote: config's configTrunkRemote order, kept here since the cell ratchet allows no new api->config import.
  const remote = config?.trunk?.remote || config?.landing?.trunkRemote;
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new Refused('LANDING_TRUNK_REMOTE', 'a runner landing pushes the trunk remote of record; set trunk.remote in pullboard.json to its git URL');
  if (!SHA.test(expect ?? '')) throw new Refused('LANDING_EXPECT', 'a landing job names the full trunk sha its items were accepted against');
  if (!REF.test(trunk)) throw new Refused('LANDING_TRUNK_REF', 'the trunk is a refs/ name, like refs/heads/main');
  if (check !== null && (!Array.isArray(check) || check.length === 0 || check.some(part => typeof part !== 'string'))) throw new Refused('LANDING_CHECK', 'a landing check is a command as a list of strings, like ["npm", "run", "gate"]');
  if (forced !== null && (typeof forced !== 'string' || !forced.trim())) throw new Refused('FORCED_REASON', 'a forced landing names why it went around the gate: --forced "<why>"');
  if (!Array.isArray(badges) || badges.some(entry => typeof entry?.path !== 'string' || typeof entry?.text !== 'string' || /^\/|\.\./u.test(entry.path))) throw new Refused('LANDING_BADGES', 'landing badges are { path, text } documents inside the repo, as the view\'s badgeDocuments returns them');
  const landed = landingItems(items);
  const key = createHash('sha256').update(JSON.stringify([remote, trunk, expect, landed, ...(forced ? [forced] : [])])).digest('hex').slice(0, 16);
  const ids = landed.map(entry => entry.id).join('+').slice(0, 120);
  const proof = landingProof(db, landed, config?.affectedTests, expect);
  const own = forced || check || proof ? null : ownChecks(db, landed, config);
  const separate = config?.landing?.publish === 'separate';
  return offerJob(db, { id: `land:${ids}:${key}`, kind: LANDING_JOB_KIND, priority: 'landing', needs, now,
    payload: { remote, trunk, expect, items: landed, ...(check ?? own?.gate ? { check: check ?? own.gate } : {}), ...(own?.checks ? { checks: own.checks } : {}), ...(proof ? { proof } : {}),
      ...(separate ? { publish: 'separate' } : {}), ...(badges.length ? { badges } : {}), ...(checkout ? { checkout: true } : {}), ...(forced ? { forced: forced.trim() } : {}) } });
}

/**
 * The checks a land job with no ledger proof runs on the merged tree, as 0.9.3's landing gate did: each item's own
 * check, and the project's full gate when it names no affectedTests runner. Why: a plain project's land job checked
 * nothing, so an item green at its base but red on current main landed (#6468, #6469). A job with a ledger proof has
 * neither, since the proof's files are the ones each item's gate ran, its check's among them [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: number }[]} items
 * @param {{ gate?: unknown, affectedTests?: unknown }} config
 * @returns {{ checks: Record<string, string> | null, gate: string[] | null }} checks: each item's own check by item id.
 */
function ownChecks(db, items, config) {
  const read = db.prepare('SELECT item_check FROM item WHERE item_id = ?');
  const checks = Object.fromEntries(items.map(entry => [String(entry.id), read.get(entry.id)?.item_check])
    .filter(([, command]) => typeof command === 'string' && command.trim()).map(([id, command]) => [id, command.trim()]));
  const affected = typeof config?.affectedTests === 'string' && config.affectedTests.trim();
  const gate = !affected && typeof config?.gate === 'string' && config.gate.trim() ? ['sh', '-c', config.gate.trim()] : null;
  return { checks: Object.keys(checks).length ? checks : null, gate };
}

/**
 * The proof a landing job runs on the merged tree, read only from the board's ledger: the test files its items' gates
 * proved, the runner command, and the ledger's hits for those files. The runner reruns only the files whose inputKey
 * at the merged tree misses, so an unrelated main move runs nothing. A file with a fail row at main's commit rides as
 * `mainRed`: at main's identical inputKey it is main's red, charged to main and never run, so it holds no landing.
 * Null when no item has ledger rows or there is no runner command, so such a landing checks as before [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ commit: string }[]} items
 * @param {unknown} runner the project's affectedTests command
 * @param {string} [main] the trunk sha the items were accepted against
 * @returns {{ runner: string, files: string[], ledger: ReturnType<typeof ledgerHits> } | null}
 */
export function landingProof(db, items, runner, main) {
  if (typeof runner !== 'string' || !runner.trim() || /[\0\n\r]/u.test(runner)) return null;
  const files = ledgerFiles(db, items.map(entry => entry.commit));
  if (!files.length) return null;
  const ledger = ledgerHits(db, files, { budget: 16_000 }) ?? { contexts: [], files: [] };
  const mainRed = main ? ledgerMainReds(db, files, main, ledger.contexts) : [];
  return { runner: runner.trim(), files, ledger: mainRed.length ? { ...ledger, mainRed } : ledger.files.length ? ledger : null };
}

/**
 * The landing job offered and not yet done, or null: a lander offers no second landing while one is open, since its
 * receipt settles the items first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null} The open job's id.
 */
export function openLandingJob(db) {
  return db.prepare("SELECT job_id FROM job WHERE job_kind = ? AND job_step <> 'done' ORDER BY job_created LIMIT 1").get(LANDING_JOB_KIND)?.job_id ?? null;
}
