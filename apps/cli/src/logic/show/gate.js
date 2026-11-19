/** The queued-gate lines `pullboard show` prints for an item's current hand-off record [C7]. */

/**
 * Whether an infrastructure-stopped gate no longer belongs to the open or claimed item: another seat now holds it, or
 * its bar was refrozen since. Why: #3325 was refrozen and claimed by a fresh seat, yet show still printed the old stop's
 * "nothing to do as the builder", so the new holder could not tell it had a build to do.
 *
 * @param {{ state?: string, agentId?: string, digest?: string } | null} job
 * @param {{ item_status?: string, item_owner?: string | null, item_frozen_digest?: string | null }} item
 * @returns {boolean}
 */
export function supersededStop(job, item) {
  if (job?.state !== 'infrastructure' || !['claimed', 'open'].includes(item?.item_status)) return false;
  return (job.digest ?? null) !== (item.item_frozen_digest ?? null) || (item.item_status === 'claimed' && job.agentId !== item.item_owner);
}

/**
 * The queued-gate lines for show: the gate's state and source, then its refusal and next step. A superseded
 * infrastructure stop is named as an earlier seat's gate and prints no refusal or next step, so the holder reads the
 * normal builder guidance.
 *
 * @param {{ state: string, executionCommit?: string, requeuedFor?: string, error?: { code: string, message: string, next: string }, superseded?: { agentId?: string } } | null} queued
 * @param {string | null} [gateText]
 * @returns {string[]}
 */
export function queuedGateLines(queued, gateText = null) {
  if (!queued) return [];
  if (queued.superseded) {
    return [`earlier gate: ${queued.state} at ${queued.executionCommit} for ${queued.superseded.agentId ?? 'another seat'} under an older claim or bar; it does not cover this claim`];
  }
  const lines = [`queued gate: ${gateText ?? queued.state} at ${queued.executionCommit}${queued.requeuedFor ? `; requeued on the same source after ${queued.requeuedFor}` : ''}`];
  if (queued.error) lines.push(`${queued.error.code}: ${queued.error.message}\nnext: ${queued.error.next}`);
  return lines;
}

/**
 * The line show prints for a claimed item whose newest gate passed its checks but deferred its proof to shard jobs: the
 * proof is waiting, not red. Why: a deferred receipt has gate.green false yet names no failing case, and the GATE_RED
 * line sent builders to resubmit and re-queue the whole gate while the shards were only queued [C7].
 *
 * @param {{ id: string, step: string, gate: Record<string, any> | null, settle?: string } | null} gateJob - show's newest gate job; its settle is the outcome of its newest note:shards.settled step, "stale" when the claim moved while shards ran.
 * @param {{ item_id: number, item_status?: string }} item
 * @param {Array<{ type?: string, text?: string }>} [thread] - show's thread; a settled red or unknown fact for this gate job replaces the waiting line.
 * @returns {string[]} none unless the gate is done, deferred, and the item is still claimed.
 */
export function pulledWaitingLines(gateJob, item, thread = []) {
  const gate = gateJob?.gate;
  if (gateJob?.step !== 'done' || !gate || gate.green === true || gate.deferred !== true || item?.item_status !== 'claimed') return [];
  if (gateJob.settle === 'stale') return [`GATE_STALE: gate job ${gateJob.id} settled stale; build at your claim and run pullboard submit ${item.item_id}`];
  const settled = settledGateWord(thread, gateJob.id);
  if (settled === 'red') return [`GATE_RED: gate job ${gateJob.id} settled red when its shards posted; read the failing parts in the thread, fix, commit, and run pullboard submit ${item.item_id} again`];
  if (settled === 'unknown') return [`GATE_UNKNOWN: gate job ${gateJob.id} settled unknown until main's missing receipts record; run pullboard submit ${item.item_id} again once they do`];
  if (settled) return [];
  return [`GATE_WAITING: gate job ${gateJob.id} passed its checks; its proof waits on its shard jobs, so do not resubmit #${item.item_id}`];
}

/**
 * How a gate job settled, read from the thread fact the board writes when the last shard posts: "red", "unknown", or
 * "other" for a green, waived or main-owned settle; null while no such fact exists. Why: the main gate job's receipt stays
 * deferred after its shards settle, so the receipt alone cannot tell waiting from settled [C7,#10893].
 *
 * @param {Array<{ type?: string, text?: string }>} thread - show's thread entries.
 * @param {string} jobId
 * @returns {'red' | 'unknown' | 'other' | null}
 */
export function settledGateWord(thread, jobId) {
  const prefix = `Gate job ${jobId} `;
  for (const entry of [...(Array.isArray(thread) ? thread : [])].reverse()) {
    if (entry?.type !== 'fact' || typeof entry.text !== 'string' || !entry.text.startsWith(prefix)) continue;
    const rest = entry.text.slice(prefix.length);
    if (rest.startsWith('passed its checks')) continue;
    if (/^red at /u.test(rest)) return 'red';
    if (/^unknown at /u.test(rest)) return 'unknown';
    if (/^(green|waived|passed but not submitted)/u.test(rest)) return 'other';
  }
  return null;
}

/**
 * The one line naming the seconds a done pulled gate job waited for a runner; none when its receipt recorded no wait [C7].
 *
 * @param {{ step: string, gate: Record<string, any> | null } | null} gateJob - show's newest gate job.
 * @returns {string[]}
 */
export function queueWaitLines(gateJob) {
  const seconds = gateJob?.gate?.queueWaitSeconds;
  return gateJob?.step === 'done' && Number.isFinite(seconds) ? [`queueWaitSeconds: ${seconds}`] : [];
}

/** Budget: a red pulled gate prints at most 10 failing cases, and 10 tail lines for a phase that names none. */
const RED_ROWS = 10;
/** Budget: one failing case's error is one line of at most 240 characters; the full log keeps the rest. */
const RED_ERROR_CHARS = 240;

/**
 * The lines show prints for a claimed item whose newest pulled gate came back red, read from its receipt: GATE_RED with
 * the counts, each failing case once with its first error text, a bounded output tail for a red phase that names no
 * case, and the full log. Why: a pulled submit returns at once, so this is where the builder reads the red [C7,V10].
 *
 * @param {{ id: string, step: string, gate: Record<string, any> | null } | null} gateJob - show's newest gate job.
 * @param {{ item_id: number, item_status?: string }} item
 * @returns {string[]} none unless the gate is done, red, and the item is still claimed.
 */
export function pulledRedLines(gateJob, item) {
  const gate = gateJob?.gate;
  if (gateJob?.step !== 'done' || !gate || gate.green === true || gate.deferred === true || item?.item_status !== 'claimed') return [];
  const oneLine = text => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, RED_ERROR_CHARS);
  const counts = gate.counts ? `: ${gate.counts.passed ?? 'unknown'} passed, ${gate.counts.failed ?? 'unknown'} failed` : '';
  const seen = new Set(), cases = [], tails = [];
  for (const phase of Array.isArray(gate.phases) ? gate.phases : []) {
    if (!phase || phase.status === 0) continue;
    const rows = (Array.isArray(phase.errors) ? phase.errors : []).filter(row => row && typeof row.name === 'string');
    for (const row of rows) {
      const key = `${row.file}\0${row.name}`;
      if (!seen.has(key)) { seen.add(key); cases.push(`  ${row.file ?? 'unknown file'} :: ${oneLine(row.name)}: ${oneLine(row.error)}`); }
    }
    if (!rows.length) tails.push(...String(phase.exit || phase.tail || '').trimEnd().split('\n').slice(-RED_ROWS).map(line => `  ${phase.role} | ${line.slice(0, RED_ERROR_CHARS)}`));
  }
  const runner = gate.logRunner ? `; its full log is on runner ${gate.logRunner}` : '';
  return [`GATE_RED: gate job ${gateJob.id} is red${counts}${runner}; fix the named cases, commit, and run pullboard submit ${item.item_id} again`,
    ...cases.slice(0, RED_ROWS), ...(cases.length > RED_ROWS ? [`  ${cases.length - RED_ROWS} more failing cases in the full log`] : []),
    ...tails.slice(-RED_ROWS), ...(typeof gate.logPath === 'string' ? [`full log: ${gate.logPath}`] : [])];
}

/**
 * The phases of the landing receipt that merged an item, as show prints them: one line each, in the order the runner job ran them.
 * Why: a landing's time was recorded but nothing read it, so a slow landing could not be told from a slow gate [C7,#9079].
 *
 * @param {Array<{ phase: string, ms: number }> | undefined} phases - the item's recorded landing phases; none for an item landed before they were kept.
 * @returns {string[]} none when no phase was recorded.
 */
export function landingPhaseLines(phases) {
  return (Array.isArray(phases) ? phases : []).map(row => `landing phase ${row.phase}: ${row.ms} ms`);
}

/**
 * The exact-tree record of the newest landing batch that carried an item, or undefined for an item landed before the record existed.
 * Why a text pre-filter: a board holds thousands of batch snapshots, and only the ones carrying a record are parsed [V38].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's handle.
 * @param {number} id
 * @returns {{ tree: string, pin?: string, cells?: string[], result?: string } | undefined}
 */
export function exactTreeOf(db, id) {
  const row = db.prepare(`SELECT json_extract(event_detail, '$.batch.exactTree') AS record FROM event WHERE event_kind = 'landing_batch'
    AND json_extract(event_detail, '$.batch.state') = 'landed' AND instr(event_detail, '"exactTree"') > 0
    AND EXISTS (SELECT 1 FROM json_each(event_detail, '$.batch.items') WHERE json_extract(value, '$.id') = ?) ORDER BY event_id DESC LIMIT 1`).get(id);
  return row?.record ? JSON.parse(row.record) : undefined;
}

/** The one line `pullboard show` prints beside the landing: the tree id, the tooling commit, the cells run and the result [V38]. */
export function exactTreeLine(record) {
  const proved = record.result ? `${record.result}, cells ${(record.cells ?? []).join(', ') || 'none'}` : 'not proved';
  return `landing exact tree ${record.tree.slice(0, 12)}: tooling ${record.pin ? record.pin.slice(0, 12) : 'unknown'}, ${proved}`;
}
