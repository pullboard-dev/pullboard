/** Ending an item's stale gate jobs: older candidates' open jobs on a new offer, and every open job of an item that landed [C7,#8816]. */
import { endJobs } from './jobs.js';
import { SHARD_JOB_KIND } from './jobs.js';
import { atomically } from '../../../jobs/index.js';
import { endJob } from '../../../jobs/index.js';
import { resolveCommit } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/**
 * End the item's open gate jobs, and the gate-shard jobs of its proof, other than the one for `keep`, when `enabled` (gate.endStaleJobs, off by default).
 * With no `keep` every open gate job of the item ends: the item landed, so no candidate of it can land again.
 * Why: a resubmitted or landed item's older gate jobs still held runner time (#8743, #8736 stayed offered after landing), and so did their open shards (#11817).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, keep?: string | null, enabled?: boolean, reason?: string, now?: number }} fields
 * @returns {string[]} The jobs ended now.
 */
export function endStaleGateJobs(db, { item, keep = null, enabled = false, reason = keep ? 'a newer gate candidate was offered for the item' : 'the item landed', now = Date.now() }) {
  if (enabled !== true) return [];
  const open = db.prepare("SELECT job_id FROM job WHERE job_kind IN ('gate', ?) AND job_item = ? AND job_step <> 'done' AND (? IS NULL OR job_candidate <> ?)").all(SHARD_JOB_KIND, item, keep, keep);
  return endJobs(db, open.map(row => row.job_id), { reason, now });
}

/**
 * The offered gate-shard jobs of item gates, read in one pass the job_step index serves: only `gate:` shard ids, so a
 * release's or a push's shards are never read as an item's gate.
 */
const OFFERED_GATE_SHARDS = "SELECT job_id, job_item, job_candidate FROM job WHERE job_step = 'offered' AND job_kind = ? AND +job_id >= 'gate:' AND +job_id < 'gate:' || char(65535) ORDER BY job_created, job_id";

/**
 * End the offered (unclaimed) shards of every gate whose candidate does not contain `before`, each as withdrawn with a
 * detail naming the missing commit and the next step. Claimed shards run on; a gate whose candidate contains `before`,
 * or whose candidate git cannot read (returned as unknown), is left as it is. With `dryRun` the same gates are returned
 * and nothing ends. Once a gate's last shard is done, settleDoneShardGates settles it red to its builder.
 * Why: gates built before a main fix held shards certain to go red, and nothing ended a gate whose gate job was done (#12166).
 *
 * Cost: one indexed read of the offered jobs and one ancestry check per distinct candidate, never per shard.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's job store (its runs file while runs_store is on).
 * @param {{ root: string, before: string, dryRun?: boolean, now?: number }} request - root: the repository holding the candidates.
 * @returns {{ before: string, gates: { gate: string, item: number | null, candidate: string, shards: string[] }[], unknown: string[], ended: number }}
 */
export function endStaleShardOffers(db, { root, before, dryRun = false, now }) {
  const commit = typeof before === 'string' && before.trim() ? resolveCommit(root, before.trim()) : null;
  if (!commit) throw new Refused('STALE_BEFORE_UNKNOWN', `git cannot resolve ${before} to a commit in ${root}`, 'name a main commit by its sha');
  const byCandidate = new Map();
  for (const row of db.prepare(OFFERED_GATE_SHARDS).all(SHARD_JOB_KIND)) {
    const rows = byCandidate.get(row.job_candidate) ?? [];
    rows.push(row);
    byCandidate.set(row.job_candidate, rows);
  }
  const gates = new Map(), unknown = [];
  for (const [candidate, rows] of byCandidate) {
    // merge-base --is-ancestor exits 1 when the commit is missing from the candidate, 0 when present; any other exit cannot judge.
    const status = typeof candidate === 'string' && candidate ? tryGit(root, ['merge-base', '--is-ancestor', commit, candidate]).status : null;
    if (status === 0) continue;
    if (status !== 1) { unknown.push(candidate ?? ''); continue; }
    for (const row of rows) {
      const gate = row.job_id.slice(0, row.job_id.lastIndexOf(':shard:'));
      const one = gates.get(gate) ?? { gate, item: row.job_item, candidate, shards: [] };
      one.shards.push(row.job_id);
      gates.set(gate, one);
    }
  }
  const found = [...gates.values()];
  if (dryRun) return { before: commit, gates: found, unknown, ended: 0 };
  const detail = `the gate's candidate does not contain main commit ${commit.slice(0, 12)}; merge main and submit again`;
  const step = db.prepare('SELECT job_step FROM job WHERE job_id = ?');
  // A shard a runner claimed since the read runs on: each ends only while it still reads offered.
  const ended = found.map(one => ({ ...one, shards: atomically(db, () => one.shards.filter(id => step.get(id)?.job_step === 'offered'
    && endJob(db, id, 'withdrawn', { detail }, now === undefined ? {} : { now }))) })).filter(one => one.shards.length);
  return { before: commit, gates: ended, unknown, ended: ended.reduce((total, one) => total + one.shards.length, 0) };
}
