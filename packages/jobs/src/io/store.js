/** Read and write job rows on the board's SQLite handle [C7]. */
import { Refused } from "../../../kernel/light.js";
import { viewOf } from "../logic/view.js";
import { parseStub } from "./blobs.js";
import { readBlob } from "./blobs.js";
import { blobDirOf } from "./blobs.js";
import { readPayload } from "./blobs.js";
import { storableText } from "./blobs.js";

/**
 * Run `work` so its statements land together or not at all: in its own write transaction, or inside a savepoint
 * when the caller already holds a transaction.
 *
 * Why: `work` reads before it writes. A deferred transaction that read first cannot upgrade to a write once another
 * process committed, and SQLite answers "database is locked" at once without waiting; two drivers writing steps for
 * different jobs on one board hit that. BEGIN IMMEDIATE takes the write lock first and waits its turn.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 */
export function atomically(db, work) {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if (!/within a transaction/u.test(String(error?.message))) throw error;
    return inSavepoint(db, work);
  }
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Run `work` inside a savepoint of the caller's transaction.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 */
function inSavepoint(db, work) {
  db.exec('SAVEPOINT job_store');
  try {
    const result = work();
    db.exec('RELEASE job_store');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO job_store; RELEASE job_store');
    throw error;
  }
}

/**
 * Create a job in the `queued` step. Creating an id that exists returns the stored job unchanged.
 *
 * Why: enqueue can run twice (a retry, a second process); the second call must not reset a job that moved on.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, kind: string, item?: number|null, candidate?: string|null, base?: string|null, now?: number}} fields
 * @returns {ReturnType<typeof viewOf>}
 */
export function createJob(db, { id, kind, item = null, candidate = null, base = null, now = Date.now() }) {
  if (!id || !kind) throw new Refused('JOB_FIELDS', 'A job needs an id and a kind: pass { id, kind }.');
  db.prepare('INSERT OR IGNORE INTO job (job_id, job_kind, job_item, job_candidate, job_base, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, item, candidate, base, now, now);
  return jobView(db, id);
}

/**
 * Name what a job drives when it was created before that was known: its item, candidate and base. A field already
 * named keeps its value, so a second call never moves a job onto another candidate.
 *
 * Why: the dispatcher admits a gate's drive job from its place in line, which names only the job; the driver reads
 * the candidate from the captured request and names it before the first transition needs it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ item?: number | null, candidate?: string | null, base?: string | null }} fields
 * @returns {ReturnType<typeof viewOf>}
 */
export function nameJob(db, job, { item = null, candidate = null, base = null }) {
  db.prepare('UPDATE job SET job_item = COALESCE(job_item, ?), job_candidate = COALESCE(job_candidate, ?), job_base = COALESCE(job_base, ?) WHERE job_id = ?')
    .run(item, candidate, base, job);
  return jobView(db, job);
}

/**
 * Append a step to a job's log. A repeat of (job, name, seq) writes nothing and returns the stored payload.
 *
 * Why: a resumed driver replays steps it may already have written; the unique key makes that safe.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} name
 * @param {unknown} [payload] - Small JSON: commit ids, runner host, shard list, receipt ids.
 * @param {{seq?: number, now?: number}} [options]
 * @returns {{written: boolean, payload: any}}
 */
export function writeStep(db, job, name, payload = {}, { seq = 0, now = Date.now() } = {}) {
  if (!name) throw new Refused('JOB_STEP_NAME', 'A step needs a name: pass the step the driver just finished.');
  return atomically(db, () => {
    if (!db.prepare('SELECT 1 FROM job WHERE job_id = ?').get(job)) throw new Refused('JOB_MISSING', `No job ${job}: create it with createJob first.`);
    const text = JSON.stringify(payload ?? {});
    const kept = storableText(db, text, payload);
    const inserted = db.prepare('INSERT OR IGNORE INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)')
      .run(job, name, seq, kept, now);
    if (inserted.changes === 0) {
      const stored = db.prepare('SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = ? AND job_step_seq = ?').get(job, name, seq);
      const stub = parseStub(stored.job_step_payload);
      // A pruned body (the migration keeps only its hash and size) is derived data: the new write replaces it.
      if (!stub || readBlob(blobDirOf(db), stub.blob) !== null) return { written: false, payload: readPayload(db, stored.job_step_payload) };
      db.prepare('UPDATE job_step SET job_step_payload = ?, job_step_at = ? WHERE job_step_job = ? AND job_step_name = ? AND job_step_seq = ?').run(kept, now, job, name, seq);
    }
    db.prepare('UPDATE job SET job_step = ?, job_updated = ? WHERE job_id = ?').run(name, now, job);
    return { written: true, payload: payload ?? {} };
  });
}

/**
 * Write a gate job's lease note: a `note:` step that readers of the current step skip, so the lease trail shows in the trace
 * without ever reading as progress. One row per name and attempt; a repeat (a renewal) replaces it with the newest time.
 * Why: a gate that lost its runner left no record of who held the lease, for how long, or why the job ended [C7].
 * A job of another kind writes nothing, and a missing job writes nothing, so the note never changes a caller's result.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} what - `lease.grant`, `lease.renew`, `lease.release` or `end.<reason>`.
 * @param {Record<string, unknown>} payload
 * @param {number} now
 */
export function noteLease(db, job, what, payload, now) {
  db.prepare(`INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at)
    SELECT job_id, ?, job_attempt, ?, ? FROM job WHERE job_id = ? AND job_kind = 'gate'
    ON CONFLICT (job_step_job, job_step_name, job_step_seq) DO UPDATE SET job_step_payload = excluded.job_step_payload, job_step_at = excluded.job_step_at`)
    .run(`note:${what}`, JSON.stringify(payload), now, job);
}

/**
 * Write the lapsed step of a takeover: one row per lapsed attempt, in the claim's transaction. It never changes the job's current step, so views still read claimed [C7,#9247].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{ attempt: number }} lapse - What the earlier claim held and last wrote.
 * @param {number} now
 */
export function noteLapse(db, job, lapse, now) {
  db.prepare('INSERT OR IGNORE INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)')
    .run(job, 'lapsed', lapse.attempt, JSON.stringify(lapse), now);
}

/**
 * Record a runner's progress for one attempt: the first post inserts the step, a later post for the same attempt replaces it.
 *
 * Why: progress is a live reading, so the newest post wins; this lives here because the jobs store owns job_step.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {number} attempt
 * @param {string} text - The progress JSON, already validated.
 * @param {number} now
 * @returns {void}
 */
export function upsertProgressStep(db, job, attempt, text, now) {
  db.prepare(`INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, 'progress', ?, ?, ?)
    ON CONFLICT (job_step_job, job_step_name, job_step_seq) DO UPDATE SET job_step_payload = excluded.job_step_payload, job_step_at = excluded.job_step_at`).run(job, attempt, text, now);
}

/**
 * Keep one named run artifact (a log, a report) for an attempt on the board: the first post inserts the row, a later post
 * of the same name replaces it. The job's own step is left as it is, so a job stays claimable and its state never moves.
 *
 * Why: a log left only on a runner's disk is lost with its folder; the body rides in the job store, and the blob store
 * past the inline threshold, so the board can read it back on its own [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {number} attempt
 * @param {string} name - The artifact's file name.
 * @param {{ name: string, encoding: 'utf8'|'base64', body: string }} artifact
 * @param {number} now
 * @returns {void}
 */
export function upsertArtifactStep(db, job, attempt, name, artifact, now) {
  const kept = storableText(db, JSON.stringify(artifact), artifact);
  db.prepare(`INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (job_step_job, job_step_name, job_step_seq) DO UPDATE SET job_step_payload = excluded.job_step_payload, job_step_at = excluded.job_step_at`).run(job, `artifact:${name}`, attempt, kept, now);
}

/**
 * The artifacts of a job's newest attempt that has any, by name, each with its body decoded to bytes.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {Map<string, Buffer>}
 */
export function readArtifactSteps(db, job) {
  const rows = db.prepare("SELECT job_step_name AS name, job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name LIKE 'artifact:%' ORDER BY job_step_seq").all(job);
  const found = new Map();
  for (const row of rows) {
    const artifact = readPayload(db, row.payload);
    if (artifact.pruned) continue;
    found.set(row.name.slice('artifact:'.length), Buffer.from(artifact.body, artifact.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  return found;
}

/**
 * Record that something is still waiting on each of these jobs: one `alive` step per job, its time replaced by every call.
 * The job's own step is left as it is, so a job stays claimable. Why: a pre-push gate renews it while it waits, so a shard
 * whose gate has gone can be told from one still wanted (#7805).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} jobs
 * @param {number} [now]
 */
export function touchLive(db, jobs, now = Date.now()) {
  atomically(db, () => {
    for (const job of jobs) {
      db.prepare(`INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) SELECT job_id, 'alive', 0, '{}', ? FROM job WHERE job_id = ? AND job_step <> 'done'
        ON CONFLICT (job_step_job, job_step_name, job_step_seq) DO UPDATE SET job_step_at = excluded.job_step_at`).run(now, job);
    }
  });
}

/**
 * When something last said it waits on a job (touchLive), or when the job was created if nothing ever did; null for no such job.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {number | null}
 */
export function liveSince(db, job) {
  const row = db.prepare(`SELECT job.job_created AS created, (SELECT job_step_at FROM job_step WHERE job_step_job = job.job_id AND job_step_name = 'alive' AND job_step_seq = 0) AS alive FROM job WHERE job.job_id = ?`).get(job);
  return row ? Math.max(row.created, row.alive ?? 0) : null;
}

/** Delete step rows by id in one write; the archive pass calls it once the rows are durable elsewhere. */
export function dropSteps(db, ids) {
  atomically(db, () => { for (const id of ids) db.prepare('DELETE FROM job_step WHERE job_step_id = ?').run(id); });
}

/**
 * The job and its steps, with the current step being the last one written; null when the job does not exist.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {ReturnType<typeof viewOf> | null}
 */
export function jobView(db, job) {
  const row = db.prepare('SELECT * FROM job WHERE job_id = ?').get(job);
  if (!row) return null;
  return viewOf(row, db.prepare('SELECT * FROM job_step WHERE job_step_job = ? ORDER BY job_step_id').all(job), text => readPayload(db, text));
}

/**
 * Every job of one kind, optionally for one item, oldest first, each as its job view.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kind: string, item?: number|null}} filter
 * @returns {ReturnType<typeof viewOf>[]}
 */
export function jobsOf(db, { kind, item = null }) {
  if (!kind) throw new Refused('JOB_FIELDS', 'Listing jobs needs a kind: pass { kind }.');
  const rows = item === null
    ? db.prepare('SELECT job_id FROM job WHERE job_kind = ? ORDER BY job_created, job_id').all(kind)
    : db.prepare('SELECT job_id FROM job WHERE job_kind = ? AND job_item = ? ORDER BY job_created, job_id').all(kind, item);
  return rows.map(row => jobView(db, row.job_id));
}

/**
 * Every job of one kind whose driver holds a live lease, each as its job view. Why a lease filter: a board keeps every
 * gate job it ever ran, and a watch over live drivers must not read them all on every scan.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kind: string, now?: number}} filter
 * @returns {ReturnType<typeof viewOf>[]}
 */
export function leasedJobs(db, { kind, now = Date.now() }) {
  if (!kind) throw new Refused('JOB_FIELDS', 'Listing leased jobs needs a kind: pass { kind }.');
  return db.prepare("SELECT job_id FROM job WHERE job_kind = ? AND job_lease_owner IS NOT NULL AND job_lease_until >= ? AND job_step <> 'done' ORDER BY job_created, job_id")
    .all(kind, now).map(row => jobView(db, row.job_id));
}
