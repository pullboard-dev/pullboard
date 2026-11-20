/** Read and write job rows on the board's SQLite handle [C7]. */
import { createHash } from "node:crypto";
import { Refused } from "../../../kernel/light.js";
import { viewOf } from "../logic/view.js";
import { parseStub } from "./blobs.js";
import { readBlob } from "./blobs.js";
import { blobDirOf } from "./blobs.js";
import { readPayload } from "./blobs.js";
import { storableText } from "./blobs.js";

/** The write-hold port the api fills so a job write is recorded like any board write; none set leaves atomically() as it was [C7]. */
let writeHold = null;

/**
 * Set the write-hold port: { prepare(db), begin(db, marker), finish(record, outcome), discard(marker) }, or null to clear it.
 * Why: the jobs cell may not import the store that owns the board-write markers, so the api passes those functions in.
 *
 * @param {{ prepare: (db: object) => unknown, begin: (db: object, marker: unknown) => unknown, finish: (record: unknown, outcome: 'released' | 'rolled-back') => void, discard: (marker: unknown) => void } | null} hold
 * @returns {void}
 */
export function setWriteHold(hold) {
  writeHold = hold ?? null;
}

/** How long atomically() keeps retrying a busy board before it refuses with BOARD_BUSY, in ms [C7]. */
const BUSY_BOUND_MS = 30000;
/** The first and the longest busy_timeout a retry of a busy BEGIN waits in SQLite, in ms; it doubles from the first to the longest [C7]. */
const BUSY_FIRST_PAUSE_MS = 50;
const BUSY_LONGEST_PAUSE_MS = 500;

/**
 * Whether a SQLite error says another connection holds the database (SQLITE_BUSY or SQLITE_LOCKED).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isBusy(error) {
  const code = Number(error?.errcode);
  if (Number.isInteger(code) && ((code & 0xff) === 5 || (code & 0xff) === 6)) return true;
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' || /database (table )?is locked/u.test(String(error?.message));
}

/**
 * Take the write lock with BEGIN IMMEDIATE. A busy board is retried with a short busy_timeout that doubles each time (SQLite itself waits, so the thread parks nowhere else) until
 * `boundMs` has passed in all, then refused as BOARD_BUSY; the handle's own busy_timeout is restored after.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} boundMs
 * @returns {void}
 */
function beginImmediate(db, boundMs) {
  const started = Date.now();
  try {
    db.exec('BEGIN IMMEDIATE');
    return;
  } catch (error) {
    if (!isBusy(error)) throw error;
  }
  const own = db.prepare('PRAGMA busy_timeout').get().timeout;
  let delay = BUSY_FIRST_PAUSE_MS;
  try {
    for (;;) {
      const left = boundMs - (Date.now() - started);
      if (left <= 0) throw new Refused('BOARD_BUSY', `job store is held by another process after ${Date.now() - started}ms; wait for it to finish and retry`);
      db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(delay, left))}`);
      delay = Math.min(delay * 2, BUSY_LONGEST_PAUSE_MS);
      try {
        db.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        if (!isBusy(error)) throw error;
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${own}`);
  }
}

/**
 * Run `work` so its statements land together or not at all: in its own write transaction, or inside a savepoint
 * when the caller already holds a transaction.
 *
 * Why: `work` reads before it writes. A deferred transaction that read first cannot upgrade to a write once another
 * process committed, and SQLite answers "database is locked" at once without waiting; two drivers writing steps for
 * different jobs on one board hit that. BEGIN IMMEDIATE takes the write lock first and waits its turn; when the board
 * stays held past the handle's busy_timeout it retries with a backoff for up to `boundMs`, then throws Refused BOARD_BUSY
 * instead of a raw SQLite error.
 * With a write hold set, its prepare runs before BEGIN, begin after it, and finish after COMMIT ('released') or ROLLBACK ('rolled-back');
 * a BEGIN that fails other than inside a caller's transaction discards the marker. A nested call touches none of them.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @param {{ boundMs?: number }} [options] - boundMs: the total wait on a busy board; 30 s by default.
 * @returns {T}
 */
export function atomically(db, work, { boundMs = BUSY_BOUND_MS } = {}) {
  const hold = writeHold;
  if (hold && db.isTransaction) return inSavepoint(db, work);
  const marker = hold ? hold.prepare(db) : undefined;
  try {
    beginImmediate(db, boundMs);
  } catch (error) {
    if (hold) hold.discard(marker);
    if (!/within a transaction/u.test(String(error?.message))) throw error;
    return inSavepoint(db, work);
  }
  const record = hold ? hold.begin(db, marker) : undefined;
  let result;
  try {
    result = work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (hold) hold.finish(record, 'rolled-back');
    throw error;
  }
  if (hold) hold.finish(record, 'released');
  return result;
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

/** The runs file's program table: offered program text stored once, keyed by its sha256 [B2,P7]. */
export const PROGRAM_SCHEMA_SQL = 'CREATE TABLE IF NOT EXISTS program (program_sha256 TEXT PRIMARY KEY, program_text TEXT NOT NULL)';

/** A request string of at least this many characters, in its argv or entry, is program text the runs file stores once by hash [B2,P7]. */
export const PROGRAM_MIN_CHARS = 256;

/**
 * Store program text once in the runs file's program table, keyed by its sha256; a text already there is left as it is.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The runs file's handle.
 * @param {string} text
 * @returns {string} The sha256 of the text.
 */
export function putProgram(db, text) {
  const sha = createHash('sha256').update(text).digest('hex');
  db.prepare('INSERT OR IGNORE INTO program (program_sha256, program_text) VALUES (?, ?)').run(sha, text);
  return sha;
}

/**
 * The program text stored under a hash, or null when the table holds none.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sha
 * @returns {string | null}
 */
export function readProgram(db, sha) {
  return db.prepare('SELECT program_text AS text FROM program WHERE program_sha256 = ?').get(sha)?.text ?? null;
}

/** The hash a program stub holds, or null when the value is no stub. */
const stubHash = value => (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && /^[0-9a-f]{64}$/u.test(value.$program ?? '') ? value.$program : null);

/**
 * A copy of a job request whose program text (each long string of its `run` argv and its `input.entry`) is stored once in the
 * runs file and replaced by `{ $program: sha256 }`, so an offer holds only the hash.
 * Why: 214 MB of offered rows held 36 distinct program texts; the table keeps each once [B2,P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The runs file's handle.
 * @param {Record<string, unknown> | null} request
 * @returns {Record<string, unknown> | null}
 */
export function dehydrateRequest(db, request) {
  if (!request) return request;
  const long = value => typeof value === 'string' && value.length >= PROGRAM_MIN_CHARS;
  const copy = { ...request };
  if (Array.isArray(copy.run)) copy.run = copy.run.map(part => (long(part) ? { $program: putProgram(db, part) } : part));
  if (copy.input && typeof copy.input === 'object' && long(copy.input.entry)) copy.input = { ...copy.input, entry: { $program: putProgram(db, copy.input.entry) } };
  return copy;
}

/**
 * The request as it was offered: each program stub of its `run` argv and `input.entry` read back from the program table.
 * A request with no stub comes back as it is.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The handle the request was read from.
 * @param {Record<string, unknown> | null} request
 * @returns {Record<string, unknown> | null}
 */
export function hydrateRequest(db, request) {
  if (!request) return request;
  const text = stub => {
    const body = readProgram(db, stubHash(stub));
    if (body === null) throw new Refused('JOB_REQUEST', `an offered program ${stubHash(stub)} is no longer in the runs file; resubmit the item for a new job`);
    return body;
  };
  const copy = { ...request };
  if (Array.isArray(copy.run) && copy.run.some(stubHash)) copy.run = copy.run.map(part => (stubHash(part) ? text(part) : part));
  if (stubHash(copy.input?.entry)) copy.input = { ...copy.input, entry: text(copy.input.entry) };
  return copy;
}
