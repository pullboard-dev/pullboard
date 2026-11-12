/** The board side of a runner landing job: one queue row naming the accepted items and the trunk sha expected [P7]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { offerJob } from './jobs.js';
import { landingPermit } from '../../../git/index.js';

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
 * Behind gate.runnerDispatch pull with trunk.remote set, so today's lander stays the default.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ items: { id: number, commit: string, ref?: string }[], expect: string, config: { trunk?: { remote?: string }, landing?: { trunkRemote?: string } },
 *   mode: string, trunk?: string, check?: string[] | null, needs?: string[], checkout?: boolean, now?: number }} request - checkout: the
 *   remote is the board host's own checkout with trunk checked out, so the push updates its work tree too [P7].
 * @returns {ReturnType<typeof offerJob>}
 */
export function offerLandingJob(db, { items, expect, config, mode, trunk = 'refs/heads/main', check = null, needs = [], checkout = false, now = Date.now() }) {
  if (mode !== 'pull') throw new Refused('LANDING_NOT_PULL', 'landing runs as a runner job only when gate.runnerDispatch is pull; today\'s lander lands this board');
  // trunk.remote, else its old name landing.trunkRemote: config's configTrunkRemote order, kept here since the cell ratchet allows no new api->config import.
  const remote = config?.trunk?.remote || config?.landing?.trunkRemote;
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new Refused('LANDING_TRUNK_REMOTE', 'a runner landing pushes the trunk remote of record; set trunk.remote in pullboard.json to its git URL');
  if (!SHA.test(expect ?? '')) throw new Refused('LANDING_EXPECT', 'a landing job names the full trunk sha its items were accepted against');
  if (!REF.test(trunk)) throw new Refused('LANDING_TRUNK_REF', 'the trunk is a refs/ name, like refs/heads/main');
  if (check !== null && (!Array.isArray(check) || check.length === 0 || check.some(part => typeof part !== 'string'))) throw new Refused('LANDING_CHECK', 'a landing check is a command as a list of strings, like ["npm", "run", "gate"]');
  const landed = landingItems(items);
  const key = createHash('sha256').update(JSON.stringify([remote, trunk, expect, landed])).digest('hex').slice(0, 16);
  const ids = landed.map(entry => entry.id).join('+').slice(0, 120);
  return offerJob(db, { id: `land:${ids}:${key}`, kind: LANDING_JOB_KIND, needs, now,
    payload: { remote, trunk, expect, items: landed, ...(check ? { check } : {}), ...(checkout ? { checkout: true } : {}) } });
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

/**
 * Add the landing permit to a land job's claim or renewal answer: the board's receipt for that lease, which the job's
 * trunk push carries so the trunk guard accepts it (#5848). Other answers, and a board with no landing key, pass as
 * they are.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} body - The queue call.
 * @param {Record<string, any>} answer - jobQueueCall's answer to it.
 * @param {() => string | null} keyOf - The board's landing key, read only for a land job's lease.
 * @returns {Record<string, any>}
 */
export function withLandingPermit(db, body, answer, keyOf) {
  const lease = body?.action === 'claim' ? answer?.claim : body?.action === 'renew' && answer?.renewed ? { job: body.job, leaseUntil: answer.leaseUntil } : null;
  if (!lease) return answer;
  const row = db.prepare(`SELECT job.job_kind, step.job_step_payload FROM job JOIN job_step AS step ON step.job_step_job = job.job_id
    AND step.job_step_name = 'offered' AND step.job_step_seq = 0 WHERE job.job_id = ?`).get(lease.job);
  const key = row?.job_kind === LANDING_JOB_KIND ? keyOf() : null;
  if (!key) return answer;
  const { payload } = JSON.parse(row.job_step_payload);
  const fields = { job: lease.job, runner: body.runner, leaseUntil: lease.leaseUntil };
  const permit = { ...fields, mac: landingPermit(key, { ...fields, trunk: payload.trunk }) };
  return body.action === 'claim' ? { ...answer, claim: { ...answer.claim, permit } } : { ...answer, permit };
}
