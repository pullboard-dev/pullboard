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
 * @param {{ id: string, step: string, gate: Record<string, any> | null } | null} gateJob - show's newest gate job.
 * @param {{ item_id: number, item_status?: string }} item
 * @returns {string[]} none unless the gate is done, deferred, and the item is still claimed.
 */
export function pulledWaitingLines(gateJob, item) {
  const gate = gateJob?.gate;
  if (gateJob?.step !== 'done' || !gate || gate.green === true || gate.deferred !== true || item?.item_status !== 'claimed') return [];
  return [`GATE_WAITING: gate job ${gateJob.id} passed its checks; its proof waits on its shard jobs, so do not resubmit #${item.item_id}`];
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
