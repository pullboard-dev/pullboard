/** A release's shards as board jobs: offered through offerJob as a gate's proof shards are, and recorded as participation once claimed [P7,C7,#8165]. */
import { createHash } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { atomically } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { SHARD_JOB_KIND } from './jobs.js';
import { offerJob } from './jobs.js';

// Budget: a release offers at most this many shard jobs, as a gate's proof does (gate.js MAX_SHARDS).
const MAX_RELEASE_SHARDS = 32;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RELEASE_ID = /^[a-f0-9-]{36}$/u;

/** The id of one release shard's job: `release:<id>:shard:<n>`, so a release's shards are found by prefix. */
function shardJobId(release, index) {
  return `release:${release}:shard:${index + 1}`;
}

/**
 * Offer a release's planned shards as gate-shard jobs any runner pulls, one per shard, each running the shard's own
 * command at the release head through the gate's bootstrap and entry. Why the board offers them: a pulled release
 * hung when its shards could only be placed on local or SSH executors; the board already holds the queue [P7,#8165].
 * Offering ids that exist leaves them as they stand, so a retried release never resets a shard a runner holds.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ release: string, head: string, base: string, mode: string, gate: { run: string[], entry: string, commits?: string[], needs?: string[] },
 *   shards: { files: string[], command: string }[], now?: number }} request - mode: the board's queue mode (boardQueueMode); only pull offers.
 * @returns {string[]} The shard job ids in plan order.
 */
export function offerReleaseShards(db, { release, head, base, mode, gate, shards, now = Date.now() }) {
  if (mode !== 'pull') throw new Refused('RELEASE_SHARDS_MODE', 'a release offers its shards as board jobs only while the machine dispatches by pull', 'set gate.runnerDispatch to pull, or run the release on its own executors');
  if (!RELEASE_ID.test(release ?? '') || !FULL_SHA.test(head ?? '') || !FULL_SHA.test(base ?? '')) throw new Refused('RELEASE_SHARDS', 'a release\'s shards name its id and the full head and base commits they prove', 'send release as its 36-character id, and head and base as full shas');
  if (!Array.isArray(shards) || !shards.length || shards.length > MAX_RELEASE_SHARDS
    || shards.some(part => !Array.isArray(part?.files) || !part.files.length || typeof part.command !== 'string' || !part.command.trim() || /[\0\n\r]/u.test(part.command))
    || !Array.isArray(gate?.run) || !gate.run.length || typeof gate.entry !== 'string') {
    throw new Refused('RELEASE_SHARDS', `a release offers 1 to ${MAX_RELEASE_SHARDS} shards of { files, command } and names its gate as { run, entry }`, 'send the plan the release made and the gate bootstrap it runs');
  }
  return atomically(db, () => shards.map((part, index) => offerJob(db, { id: shardJobId(release, index), kind: SHARD_JOB_KIND, priority: 'gate', needs: gate.needs ?? [], candidate: head, base, now,
    request: { run: gate.run, gate: `release:${release}`, commits: gate.commits ?? [], input: { main: base, entry: gate.entry, data: { main: base, source: head,
      shard: { index: index + 1, of: shards.length, files: part.files, command: part.command } } } } }).id));
}

/**
 * The participation a release's shard jobs make so far, in the shape runLandingShards writes it: each shard names the
 * runner that claimed its job as its executor, the head and tree it ran, a digest of its command and whether its
 * receipt came back green. A shard no runner has claimed has a null executor and is not green [P7,C7,#8165].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ release: string, head: string, tree: string, shards: { files: string[], command: string }[] }} fields
 * @returns {{ shard: string, files: string[], executor: string | null, head: string | null, tree: string | null, command: string | null, green: boolean, complete: boolean, cleanupVerified: boolean }[]}
 */
export function releaseParticipationShards(db, { release, head, tree, shards }) {
  return shards.map((part, index) => {
    const view = jobView(db, shardJobId(release, index));
    const step = [...(view?.steps ?? [])].reverse().find(row => row.name === 'receipt')?.payload;
    // A finished job holds no lease, so the runner that posted its receipt is the one that claimed it.
    const holder = [view?.leaseOwner, step?.runner].find(name => typeof name === 'string' && name !== '') ?? null;
    const claimed = holder !== null;
    const posted = step?.receipt;
    const green = posted?.status === 0 && posted?.gate?.green === true;
    return { shard: `${index + 1}/${shards.length}`, files: [...part.files].sort(), executor: holder, head: claimed ? head : null, tree: claimed ? tree : null,
      command: claimed ? createHash('sha256').update(part.command).digest('hex') : null, green, complete: posted !== undefined, cleanupVerified: posted?.gate?.cleanupVerified === true };
  });
}
