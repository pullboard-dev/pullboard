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

/**
 * Whether the item's newest gate job passed its checks, left its proof to shard jobs, and has not settled: a shard job is
 * still offered or claimed (held for as long as it is), every shard is done but the combined result has not applied (no
 * `note:shards.settled` step), or it settled unknown, which holds until its settled note changes (red and review outcomes are settled). Why: the gate is the board's
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
    const settled = board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'note:shards.settled' ORDER BY job_step_id DESC LIMIT 1").get(gate.job_id);
    // An unknown outcome (main's receipt missing) holds with no time bound: gate.settleOnMainReceipt settles it when the receipt records, and a later settled note, red or review, ends the hold [#11924].
    if (settled !== undefined && /"outcome"\s*:\s*"unknown"/u.test(settled.payload)) return true;
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
