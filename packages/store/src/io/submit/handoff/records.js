/** Read-only queued-submit projections never grant proof or actor authority [V4,H16]. */

/**
 * True when the board has both job tables. An older board read without an owning open has none yet, and then holds
 * no hand-off record anywhere a reader may use.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function hasJobTables(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").get().n === 2;
}

/**
 * The record a job step carries, or undefined when its payload holds none.
 *
 * Why the text check first: most steps a driver writes carry no record, and parsing every payload costs more than
 * looking for the key.
 *
 * @param {string} payload - A job_step payload.
 * @returns {Record<string, any> | undefined}
 */
function recordOf(payload) {
  if (!payload.includes('"record"')) return undefined;
  try { return JSON.parse(payload).record ?? undefined; } catch { return undefined; }
}

/** True while the board keeps run records on its run rows (board_meta runs_store). */
function runsStoreOn(db) {
  return db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'runs_store'").get()?.meta_value === '1';
}

/**
 * The hand-off records the board's run rows hold, newest first, as {item, record}: one item's, or every item's.
 * Why: with runs_store on a gate job's record is its run row's run_record, written in the move that saved it [B2,M3].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number | null} item - Read this one item, or every item when null.
 * @param {boolean} [live] - Only items not yet verified or withdrawn.
 * @returns {Generator<{ item: number, record: Record<string, any> }>}
 */
function* runRecordRows(db, item, live = false) {
  if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = 'run'").get().n !== 1) return;
  const rows = db.prepare(`SELECT run_item AS item, run_record AS record FROM run WHERE run_kind = 'gate' AND run_record IS NOT NULL
    ${item === null ? 'AND run_item IS NOT NULL' : 'AND run_item = ?'}${live ? " AND run_item IN (SELECT item_id FROM item WHERE item_status NOT IN ('verified', 'withdrawn'))" : ''}
    ORDER BY run_updated DESC, rowid DESC`).iterate(...(item === null ? [] : [item]));
  for (const row of rows) {
    try { yield { item: row.item, record: JSON.parse(row.record) }; } catch { /* an unreadable record is no record */ }
  }
}

/**
 * The item's current submit hand-off record: the record on the newest step of its gate jobs, read from the job
 * tables the jobs cell writes. Undefined when no gate job step carries one.
 *
 * Why the newest step across jobs: a retry starts a new job for the same item, so the current record is the newest
 * step, not the newest job [C7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @returns {Record<string, any> | undefined}
 */
export function handoffRecord(db, item) {
  if (runsStoreOn(db)) return runRecordRows(db, item).next().value?.record;
  if (!hasJobTables(db)) return undefined;
  const rows = db.prepare(`SELECT s.job_step_payload AS payload FROM job j JOIN job_step s ON s.job_step_job = j.job_id
    WHERE j.job_kind = 'gate' AND j.job_item = ? ORDER BY s.job_step_id DESC`).iterate(item);
  for (const row of rows) {
    const record = recordOf(row.payload);
    if (record !== undefined) return record;
  }
  return undefined;
}

/**
 * Every item's current hand-off record in one read, by item id: the newest record-carrying step across each item's
 * gate jobs, as handoffRecord reads one.
 *
 * Why one read: list, status and the sweeps look at every item, and a read per item scanned the job tables once each.
 * Only each job's last step is read, since every step the hand-off writes carries the whole record.
 *
 * With `live`, only items not yet verified or withdrawn: itemStage reads a closed item's stage from its status and merge
 * alone, so a lister never needs their records, and a board of thousands of closed items skips thousands of job reads [I6].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ live?: boolean }} [options]
 * @returns {Map<number, Record<string, any>>}
 */
export function handoffRecords(db, { live = false } = {}) {
  const records = new Map();
  if (runsStoreOn(db)) {
    for (const row of runRecordRows(db, null, live)) if (!records.has(row.item)) records.set(row.item, row.record);
    return records;
  }
  if (!hasJobTables(db)) return records;
  // Keys only: the payloads of a big board total megabytes, and an ORDER BY over them spills a temp file (#11920).
  const keys = db.prepare(`SELECT j.job_item AS item, s.job_step_id AS step FROM job j
    JOIN job_step s ON s.job_step_id = (SELECT MAX(job_step_id) FROM job_step WHERE job_step_job = j.job_id AND job_step_name NOT LIKE 'note:%')
    WHERE j.job_kind = 'gate' AND j.job_item IS NOT NULL${live ? " AND j.job_item IN (SELECT item_id FROM item WHERE item_status NOT IN ('verified', 'withdrawn'))" : ''}`).all();
  keys.sort((a, b) => b.step - a.step);
  const payload = db.prepare('SELECT job_step_payload AS payload FROM job_step WHERE job_step_id = ?');
  for (const key of keys) {
    if (records.has(key.item)) continue;
    const row = payload.get(key.step);
    if (!row) continue;
    const record = recordOf(row.payload);
    if (record !== undefined) records.set(key.item, record);
  }
  return records;
}

/** How long an offered gate job may sit unclaimed before the board reads it as having no runner. */
export const NO_RUNNER_MS = 30_000;

/**
 * The claimed items whose newest gate job is a pulled one still on its way (offered, claimed by a runner, or its receipt
 * not yet applied), as the queued or running record their stage reads, by item id.
 *
 * Why separate from handoffRecords: a pulled gate job carries no hand-off record, and the record's readers grant authority
 * a pulled job must never give; the stage only needs to say "in the gate" instead of "building" [C7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number | null} [only] - Read this one item, for a single-item read.
 * @param {number} [nowMs] - The observation time, for the no-runner read.
 * @returns {Map<number, {state: string, agentId: string, digest: string | null, noRunner: boolean}>}
 * noRunner is true when no runner is working the job: still offered after 30 s, or claimed with a lapsed lease (#6554).
 */
export function pulledGateRecords(db, only = null, nowMs = Date.now()) {
  const pulled = new Map();
  if (!hasJobTables(db)) return pulled;
  const rows = db.prepare(`SELECT j.job_item AS item, j.job_step AS step, j.job_updated AS updated, j.job_lease_until AS lease, i.item_owner AS owner, i.item_frozen_digest AS digest
    FROM job j JOIN item i ON i.item_id = j.job_item
    WHERE j.job_kind = 'gate' AND i.item_status = 'claimed' ${only === null ? '' : 'AND j.job_item = ?'} AND j.job_step IN ('offered', 'claimed', 'receipt')
      AND j.job_created = (SELECT MAX(job_created) FROM job newest WHERE newest.job_kind = 'gate' AND newest.job_item = j.job_item)`).iterate(...(only === null ? [] : [only]));
  for (const row of rows) pulled.set(row.item, { state: row.step === 'offered' ? 'queued' : 'running', agentId: row.owner, digest: row.digest,
    noRunner: row.step === 'offered' ? nowMs - row.updated > NO_RUNNER_MS : row.step === 'claimed' && row.lease < nowMs });
  return pulled;
}

/** The fallback bound on an unsettled sharded gate's claim, counted from when the gate job offered its shards, for a gate with no live shard job. */
export const GATE_SETTLE_HOLD_MS = 2 * 3_600_000;

/** The bound on a claim held by its own gate's unknown settle, counted from the note:shards.settled step that said unknown. */
export const GATE_UNKNOWN_HOLD_MS = 4 * 3_600_000;

/**
 * The agent that submitted the gate job: the submit request its offered step carries, else its submit_offered event,
 * else the hand-off record its own steps carry; null when none says.
 */
function gateSubmitter(board, item, job) {
  const request = board.db.prepare("SELECT json_extract(job_step_payload, '$.request.submit.agentId') AS by FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' ORDER BY job_step_id DESC LIMIT 1").get(job);
  if (typeof request?.by === 'string') return request.by;
  const offered = board.db.prepare("SELECT event_by AS by FROM event WHERE item_id = ? AND event_kind = 'submit_offered' AND json_extract(event_detail, '$.job') = ? ORDER BY event_id DESC LIMIT 1").get(item, job);
  if (offered) return offered.by;
  for (const row of board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? ORDER BY job_step_id DESC").iterate(job)) {
    const record = recordOf(row.payload);
    if (record !== undefined) return record.agentId ?? null;
  }
  return null;
}

/**
 * Whether the item's newest gate job passed its checks, left its proof to shard jobs, and has not settled: a shard job is
 * still offered or claimed (held for as long as it is), every shard is done but the combined result has not applied (no
 * `note:shards.settled` step), or it settled unknown, which holds the submitter's own claim for GATE_UNKNOWN_HOLD_MS until its settled note changes (red and review outcomes are settled). Why: the gate is the board's
 * work, and the board applies its result only while the submitting seat holds the item. #8249's claim was released while
 * its 10 shards ran [#8342], and #10883's while its 32 done shards waited for their result to apply, so that gate never
 * applied [C7,#10931].
 * A live shard job holds with no time bound: with the shard backlog at 950-2800 a gate waited more than 2 h after its
 * offer and its lapsed claim went to a fresh seat again (#11305) [C7,#11923]. Only a gate with no live shard job (shards
 * done but unsettled, or open in no live step) falls back to GATE_SETTLE_HOLD_MS, counted from the gate job's last
 * update, when it passed its checks and offered its shards, not from its creation (#11921).
 */
export function gateShardsUnsettled(board, item) {
  try {
    const gate = board.db.prepare(`SELECT job_id, MAX(job_created, COALESCE(job_updated, job_created)) AS offered FROM job WHERE job_kind = 'gate' AND job_item = ?
      ORDER BY job_created DESC, rowid DESC LIMIT 1`).get(item.item_id);
    if (!gate) return false;
    const shards = board.db.prepare(`SELECT COUNT(*) AS total, SUM(job_step IN ('offered', 'claimed')) AS live, SUM(job_step <> 'done') AS open FROM job
      WHERE job_kind = 'gate-shard' AND job_item = ? AND job_id LIKE ? || ':shard:%'`).get(item.item_id, gate.job_id);
    if (!shards.total) return false;
    if (shards.live > 0) return true;
    const settled = board.db.prepare("SELECT job_step_payload AS payload, job_step_at AS at FROM job_step WHERE job_step_job = ? AND job_step_name = 'note:shards.settled' ORDER BY job_step_id DESC LIMIT 1").get(gate.job_id);
    // An unknown outcome (main's receipt missing) holds while gate.settleOnMainReceipt may still settle it, and a later settled note, red or review, ends the hold [#11924].
    // It holds only its own submitter's claim, and only for GATE_UNKNOWN_HOLD_MS: 25 of 31 stuck claims were pinned with no bound,
    // several by a previous holder's gate, so the stale sweep never freed them [C7,B8].
    if (settled !== undefined && /"outcome"\s*:\s*"unknown"/u.test(settled.payload)) {
      return Boolean(item.item_owner) && gateSubmitter(board, item.item_id, gate.job_id) === item.item_owner && board.clock.now().getTime() - settled.at < GATE_UNKNOWN_HOLD_MS;
    }
    if (!(board.clock.now().getTime() - gate.offered < GATE_SETTLE_HOLD_MS)) return false;
    if (shards.open > 0) return true;
    return settled === undefined;
  } catch { return false; } // an older board has no job tables, so it holds no shards
}

/**
 * Read only new-engine queue observations; historical selection has no new metadata. The record lives on the item's
 * gate job in the job tables, the one place hand-off state is kept [C7].
 */
export function submitHandoff(board, id) {
  const engines = board.enginePorts.submitHandoffEngines();
  if ((board.executionEngineVersion ?? engines.current) < engines.handoff) return null;
  const record = handoffRecord(board.db, id);
  return record === undefined ? null : structuredClone(record);
}

/**
 * An active immutable job frees its holder to claim ordinary work without making it reviewable.
 *
 * With `fromJobRow` (submit.pendingFromJobRow, read by the caller) a pulled gate job still offered or held by a runner
 * counts too, read from the runner job row; the row stops counting once the job ends [C7,P7].
 */
export function pendingSubmitHandoff(board, item, { fromJobRow = false } = {}) {
  const job = submitHandoff(board, item.item_id);
  if (item.item_status === 'claimed' && job?.agentId === item.item_owner && job.digest === item.item_frozen_digest
    && ['queued', 'running'].includes(job.state)) return job;
  if (fromJobRow !== true || item.item_status !== 'claimed') return null;
  const pulled = pulledGateRecords(board.db, item.item_id).get(item.item_id);
  return pulled?.agentId === item.item_owner && pulled.digest === item.item_frozen_digest ? pulled : null;
}

/**
 * A claimed item whose own gate is queued, running (hand-off or pulled) or green at its frozen bar is waiting on its gate or reviewer,
 * not buildable: next skips it and offers new work [C7,#3532].
 */
export function awaitingGateOrReview(board, item) {
  if (pendingSubmitHandoff(board, item)) return true;
  // A pulled gate job still offered or held by a runner is the same wait, with no hand-off record [P7].
  if (item.item_status === 'claimed' && pulledGateRecords(board.db, item.item_id).has(item.item_id)) return true;
  // So is a done gate job whose proof shards have not settled: the claim stays held for the result, but it is not
  // buildable work, so next hands the seat new work instead of "you hold" (#10959). A settled red stops counting here.
  if (item.item_status === 'claimed' && gateShardsUnsettled(board, item)) return true;
  const job = item.item_status === 'claimed' ? submitHandoff(board, item.item_id) : null;
  return Boolean(job) && job.agentId === item.item_owner && job.digest === item.item_frozen_digest && job.state === 'green';
}

/** Return an unchanged worker refusal only while its original claim and frozen bar still match. */
export function submitHandoffFailure(board, item) {
  const job = submitHandoff(board, item.item_id);
  return job?.state === 'red' && (job.agentId === item.item_owner || item.item_status === 'open') && job.digest === item.item_frozen_digest
    ? job.error : null;
}

/**
 * Read the terminal record of a dead job after its successor takes the item's queue slot: the newest record on
 * that job's own steps [C7,V4].
 */
export function endedSubmitHandoff(board, job) {
  if (!hasJobTables(board.db)) return null;
  for (const row of board.db.prepare('SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? ORDER BY job_step_id DESC').iterate(job)) {
    const record = recordOf(row.payload);
    if (record !== undefined) return record;
  }
  return null;
}


/** Read existing store policy lazily, after module initialization; retry also consumes the record readers. */
export async function gateRecoveryPolicy() {
  const { INFRASTRUCTURE_RETRY_LIMIT } = await import('./retry.js');
  return Object.freeze({ settleHoldMs: GATE_SETTLE_HOLD_MS, unknownHoldMs: GATE_UNKNOWN_HOLD_MS,
    infrastructureRetryLimit: INFRASTRUCTURE_RETRY_LIMIT });
}

// Only these typed fields cross this observation door. Raw JSON and unknown nested objects never do.
const REFUSAL_FIELDS = { code: 'string', message: 'string', next: 'string', reason: 'string' };
const HANDOFF_FIELDS = { version: 'number', id: 'string', item: 'number', agentId: 'string', commit: 'string',
  tree: 'string', main: 'string', executionCommit: 'string', executionTree: 'string', digest: 'string',
  companionDigest: 'string', leaseMs: 'number', state: 'string', at: 'string', startedAt: 'string', completedAt: 'string',
  attempt: 'number', infrastructureRetries: 'number', recoveryRetries: 'number', retryOf: 'string',
  infrastructureNotified: 'boolean', error: REFUSAL_FIELDS };
const GATE_FIELDS = { deferred: 'boolean', outcome: 'string', green: 'boolean', full: 'boolean', main: 'string',
  source: 'string', tree: 'string', digest: 'string', status: 'number' };
const COUNT_FIELDS = { passed: 'number', failed: 'number', skipped: 'number' };
const RECEIPT_FIELDS = { id: 'string', job: 'string', run: 'string', attempt: 'number', status: 'number',
  outcome: 'string', commit: 'string', tree: 'string', main: 'string', digest: 'string',
  queueWaitSeconds: 'number', error: REFUSAL_FIELDS, gate: GATE_FIELDS, counts: COUNT_FIELDS };
const BINDING_FIELDS = { agentId: 'string', commit: 'string', tree: 'string', main: 'string', digest: 'string' };
const PAYLOAD_FIELDS = { agent: 'string', commit: 'string', tree: 'string', digest: 'string', runner: 'string',
  attempt: 'number', hopEpoch: 'number', at: 'number', leaseUntil: 'number', heartbeat: 'boolean',
  outcome: 'string', status: 'number', exactResult: 'string', error: 'string', record: HANDOFF_FIELDS,
  gate: GATE_FIELDS, request: { submit: BINDING_FIELDS },
  counts: COUNT_FIELDS, receipt: RECEIPT_FIELDS, selected: 'number', finished: 'number', failures: 'number' };
const JOB_FIELDS = { job_id: 'string', job_kind: 'string', job_item: 'number', job_candidate: 'string', job_base: 'string',
  job_step: 'string', job_attempt: 'number', job_lease_owner: 'string', job_lease_until: 'number',
  job_created: 'number', job_updated: 'number', job_applied: 'number' };
const RUN_FIELDS = { run_job: 'string', run_kind: 'string', run_item: 'number', run_candidate: 'string', run_base: 'string',
  run_state: 'string', run_attempt: 'number', run_outcome: 'string', run_lease_owner: 'string', run_lease_until: 'number',
  run_created: 'number', run_updated: 'number' };
const STEP_FIELDS = { job_step_id: 'number', job_step_job: 'string', job_step_name: 'string',
  job_step_seq: 'number', job_step_at: 'number' };

/** Project known fields with their expected types, never copying arbitrary objects through a safe-looking key. */
function evidenceFields(value, fields, reasons = [], source = 'row') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [key, type] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    if (entry === null || (typeof type === 'string' && typeof entry === type && (type !== 'number' || Number.isFinite(entry)))) result[key] = entry;
    else if (typeof type === 'object' && entry && typeof entry === 'object' && !Array.isArray(entry)) result[key] = evidenceFields(entry, type, reasons, source);
    else {
      if (typeof type === 'object') result[key] = null;
      reasons.push(`unknown-field:${source}:${key}`);
    }
  }
  if (Object.keys(value).some(key => !Object.hasOwn(fields, key))) reasons.push(`omitted-fields:${source}`);
  return result;
}

/** Select the recovery item's public columns and preserve their native numeric, text or null values. */
function recoveryItem(db, id) {
  const row = db.prepare(`SELECT item_id, item_status, item_owner, item_commit,
    item_claim_head, item_frozen_digest, item_lease_until, item_updated_at FROM item WHERE item_id = ?`).get(id);
  if (!row) return null;
  for (const [column, value] of Object.entries(row)) {
    const valid = value === null || (column === 'item_id'
      ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === 'string');
    if (!valid) delete row[column];
  }
  return row;
}

/** Freeze detached JSON observations recursively, including source references and allow-listed refusal fields. */
function freezeEvidence(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}

/** Parse and project a source, preserving unreadable evidence explicitly without exporting raw JSON. */
function evidencePayload(raw, reasons, source, fields = PAYLOAD_FIELDS) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return evidenceFields(value, fields, reasons, source);
  } catch { reasons.push(`unreadable:${source}`); return null; }
}

/** Read job rows and every step, retaining IDs, attempts, exact receipts and actual progress separately from lease renewal. */
function recoveryJobs(db, item, source, now, reasons) {
  try {
    return db.prepare('SELECT * FROM job WHERE job_item = ? ORDER BY job_created DESC, rowid DESC').all(item).map(row => {
      const steps = db.prepare('SELECT * FROM job_step WHERE job_step_job = ? ORDER BY job_step_id').all(row.job_id)
        .map(step => ({ source: `${source}.job_step:${step.job_step_id}`, row: evidenceFields(step, STEP_FIELDS),
          payload: evidencePayload(step.job_step_payload, reasons, `${source}.job_step:${step.job_step_id}`) }));
      const progress = steps.filter(step => step.row.job_step_name !== 'alive' && !step.row.job_step_name.startsWith('note:'));
      return { source: `${source}.job:${row.job_id}`, row: evidenceFields(row, JOB_FIELDS), steps,
        lease: row.job_lease_owner ? (row.job_lease_until > now ? 'live' : 'lapsed') : 'unowned',
        progress, heartbeat: steps.filter(step => step.row.job_step_name === 'alive') };
    });
  } catch (error) { reasons.push(`unavailable:${source}.jobs:read`); return []; }
}

/**
 * Capture facts only, in a board read transaction. The optional runs holder must be an existing read-only reader;
 * never open or migrate a store here. Separate-file observations are explicitly non-atomic and cannot prove exhaustion.
 * Missing identities stay unknown: a caller must re-read native sources under its eventual writer before deciding custody.
 *
 * @param {any} board - Open board with db and clock.
 * @param {number} id - Native item identity.
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync | null } | null }} [options]
 * @returns {Promise<Readonly<object>>} Detached, deeply frozen source observations; never a release or settlement verdict.
 */
export async function captureGateRecoveryEvidence(board, id, { runs = null } = {}) {
  const policy = await gateRecoveryPolicy();
  const db = board.db;
  const reasons = [];
  const answer = { observedAt: board.clock.now().getTime(), item: null, authority: null, gate: null,
    handoff: null, jobs: [], proofRuns: [], exhaustion: null, reasons };
  const own = !db.isTransaction;
  try {
    if (own) db.exec('BEGIN');
    answer.item = recoveryItem(db, id);
    answer.itemSource = `board.item:${id}`;
    if (!answer.item) reasons.push('missing:item');
    const split = runsStoreOn(db);
    answer.authority = split ? 'board.run' : 'board.job';
    // Select the latest gate before looking at its record or testing its binding. Never search older matching gates.
    const gate = split
      ? db.prepare("SELECT * FROM run WHERE run_kind = 'gate' AND run_item = ? ORDER BY run_updated DESC, rowid DESC LIMIT 1").get(id)
      : db.prepare("SELECT * FROM job WHERE job_kind = 'gate' AND job_item = ? ORDER BY job_created DESC, rowid DESC LIMIT 1").get(id);
    answer.gate = gate ? { source: `${answer.authority}:${split ? gate.run_job : gate.job_id}`, row: evidenceFields(gate, split ? RUN_FIELDS : JOB_FIELDS) } : null;
    if (!gate) reasons.push('missing:gate');
    let jobDb = db;
    if (split) {
      reasons.push('separate-store-snapshot');
      jobDb = runs?.db ?? null;
      if (!jobDb) reasons.push('unavailable:runs.jobs');
      else {
        const owner = jobDb.prepare("SELECT meta_value FROM runs_meta WHERE meta_key = 'board_id'").get()?.meta_value;
        const expected = db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get()?.meta_value;
        if (!owner || !expected || owner !== expected) { reasons.push('foreign:runs.board_id'); jobDb = null; }
      }
    }
    // A separate store is observed in its own read snapshot; do not imply one atomic snapshot across files.
    let jobsOwn = false;
    try {
      if (jobDb && jobDb !== db && !jobDb.isTransaction) { jobDb.exec('BEGIN'); jobsOwn = true; }
      if (jobDb) answer.jobs = recoveryJobs(jobDb, id, split ? 'runs' : 'board', answer.observedAt, reasons);
    } finally { if (jobsOwn) jobDb.exec('ROLLBACK'); }
    const jobId = gate ? (split ? gate.run_job : gate.job_id) : null;
    const job = answer.jobs.find(entry => entry.row.job_id === jobId);
    if (gate && split) answer.handoff = { source: `${answer.gate.source}.run_record`,
      record: evidencePayload(gate.run_record, reasons, `${answer.gate.source}.run_record`, HANDOFF_FIELDS) };
    else if (job) {
      // The newest record-bearing step on this gate is authoritative, including a malformed record. No older-gate fallback.
      const step = job.steps.slice().reverse().find(entry => entry.payload && Object.hasOwn(entry.payload, 'record'));
      if (step) answer.handoff = { source: step.source, record: step.payload.record };
    }
    const record = answer.handoff?.record;
    const gateJobs = answer.jobs.filter(entry => entry.row.job_id === jobId || entry.row.job_id.startsWith(`${jobId}:shard:`));
    for (const entry of gateJobs) {
      if (['offered', 'claimed', 'queued', 'running'].includes(entry.row.job_step) || entry.lease === 'live') reasons.push(`work-in-flight:${entry.source}`);
      for (const step of entry.steps) {
        for (const payload of [step.payload, step.payload?.receipt]) {
          if (payload?.gate?.deferred === true || String(payload?.outcome ?? payload?.gate?.outcome).toLowerCase() === 'unknown') {
            reasons.push(`unsettled:${step.source}`);
          }
        }
      }
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) reasons.push('missing:handoff');
    else {
      const item = answer.item;
      const candidate = split ? gate.run_candidate : gate.job_candidate;
      const attempt = split ? gate.run_attempt : gate.job_attempt;
      for (const [name, a, b] of [['job', record.id, jobId], ['owner', record.agentId, item?.item_owner],
        ['head', record.commit, item?.item_commit], ['candidate', record.commit, candidate],
        ['digest', record.digest, item?.item_frozen_digest], ['attempt', record.attempt, attempt],
        ['base', record.main, split ? gate.run_base : gate.job_base]]) {
        if (a === undefined || a === null || b === undefined || b === null || a !== b) reasons.push(`unknown-binding:${name}`);
      }
      if (typeof record.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(record.commit) || typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.digest)) reasons.push('unknown-binding:source');
      // saveSubmitHandoff writes a run_record directly onto the authoritative run row. Its row bindings above
      // are the envelope; only the legacy job producer wraps the record in a source-labelled job step.
      if (!split) {
        const envelope = job?.steps.find(step => step.source === answer.handoff.source)?.payload;
        if (!envelope || envelope.tree !== record.tree || envelope.agent !== record.agentId || envelope.commit !== record.commit || envelope.digest !== record.digest) reasons.push('unknown-binding:envelope');
      }
      if (typeof record.tree !== 'string' || !/^[a-f0-9]{40}$/u.test(record.tree)) reasons.push('unknown-binding:tree');
      if (item?.item_status !== 'claimed') reasons.push('unknown-binding:status');
      if (record.error?.code === 'GATE_INFRA_EXHAUSTED') {
        // Keep the producer's record; count or text alone is never exhaustion authority.
        answer.exhaustion = { source: answer.handoff.source, record,
          binding: reasons.length === 0 && record.state === 'infrastructure'
            && Number.isSafeInteger(record.infrastructureRetries) && record.infrastructureRetries >= policy.infrastructureRetryLimit
            ? 'matching-record' : 'unknown' };
      }
    }
    answer.proofRuns = answer.jobs.filter(entry => entry.row.job_kind === 'test-run').map(entry => {
      const queued = entry.steps.find(step => step.row.job_step_name === 'queued');
      return { ...entry, binding: queued?.payload?.agent === answer.item?.item_owner ? 'owner-recorded' : 'unknown' };
    });
  } catch (error) { reasons.push(`unavailable:board:read`); }
  finally { if (own && db.isTransaction) db.exec('ROLLBACK'); }
  return freezeEvidence(structuredClone(answer));
}
