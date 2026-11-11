/** The board side of a runner landing job: one queue row naming the accepted items and the trunk sha expected [P7]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
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
 * Behind gate.runnerDispatch pull with landing.trunkRemote set, so today's lander stays the default.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ items: { id: number, commit: string, ref?: string }[], expect: string, config: { landing?: { trunkRemote?: string } },
 *   mode: string, trunk?: string, check?: string[] | null, needs?: string[], now?: number }} request
 * @returns {ReturnType<typeof offerJob>}
 */
export function offerLandingJob(db, { items, expect, config, mode, trunk = 'refs/heads/main', check = null, needs = [], now = Date.now() }) {
  if (mode !== 'pull') throw new Refused('LANDING_NOT_PULL', 'landing runs as a runner job only when gate.runnerDispatch is pull; today\'s lander lands this board');
  const remote = config?.landing?.trunkRemote;
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new Refused('LANDING_TRUNK_REMOTE', 'a runner landing pushes the trunk remote of record; set landing.trunkRemote in pullboard.json to its git URL');
  if (!SHA.test(expect ?? '')) throw new Refused('LANDING_EXPECT', 'a landing job names the full trunk sha its items were accepted against');
  if (!REF.test(trunk)) throw new Refused('LANDING_TRUNK_REF', 'the trunk is a refs/ name, like refs/heads/main');
  if (check !== null && (!Array.isArray(check) || check.length === 0 || check.some(part => typeof part !== 'string'))) throw new Refused('LANDING_CHECK', 'a landing check is a command as a list of strings, like ["npm", "run", "gate"]');
  const landed = landingItems(items);
  const key = createHash('sha256').update(JSON.stringify([remote, trunk, expect, landed])).digest('hex').slice(0, 16);
  const ids = landed.map(entry => entry.id).join('+').slice(0, 120);
  return offerJob(db, { id: `land:${ids}:${key}`, kind: LANDING_JOB_KIND, needs, now,
    payload: { remote, trunk, expect, items: landed, ...(check ? { check } : {}) } });
}
