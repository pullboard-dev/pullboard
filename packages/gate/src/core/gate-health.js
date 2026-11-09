/**
 * Where gate time goes: a pure summary of queued submit gates and their phase spans over one window [C7].
 *
 * A gate is a chain of hand-off jobs, the first one and every infrastructure retry of it (`retryOf`). Its total runs
 * from the first job's queue time to the last job's end. Phase spans overlap (the submit stages start together and
 * a stage may hold a runner run), so a gate's phases are reported side by side, never summed into its total.
 */

/** Phases in the order a gate meets them; any other phase sorts after these. */
const GATE_PHASE_ORDER = Object.freeze(['queued', 'authorization', 'composition', 'cells', 'doctrine', 'changed-static', 'static',
  'admission', 'transfer', 'ready', 'tests', 'remote-analysis', 'retry', 'rerun', 'result', 'worker', 'requeue']);

/** Hand-off states whose job has not ended. */
const LIVE_STATES = new Set(['queued', 'running']);

/** Board refusal codes of an ended job, by the typed cause they are. */
const RECORD_CAUSES = Object.freeze({ RUNNER_WAIT_DEADLINE: 'deadline', RUNNER_UNAVAILABLE: 'runner-dropped', RUNNER_JOB_LOST: 'runner-dropped',
  TRANSPORT_LOST: 'transport-lost' });

/**
 * The nearest-rank percentile of a list of numbers, or null for an empty list.
 *
 * @param {number[]} values
 * @param {number} fraction - 0.5 for the median.
 * @returns {number|null}
 */
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/** Sort phase names in gate order, then by name. */
function phaseRank(name) {
  const index = GATE_PHASE_ORDER.indexOf(name);
  return index < 0 ? GATE_PHASE_ORDER.length : index;
}

/**
 * Group hand-off job records into gate chains by following `retryOf` to the first job.
 *
 * @param {object[]} records - Hand-off job records, each with id, at, state and optional retryOf.
 * @returns {object[][]} Each chain's records, oldest first.
 */
function chains(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  const rootOf = record => {
    const seen = new Set();
    let current = record;
    while (current.retryOf && byId.has(current.retryOf) && !seen.has(current.id)) { seen.add(current.id); current = byId.get(current.retryOf); }
    return current.id;
  };
  const grouped = new Map();
  for (const record of records) {
    const root = rootOf(record);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(record);
  }
  return [...grouped.values()].map(list => list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
}

/**
 * The phase durations of one gate: its jobs' spans by phase, plus, for a job with no spans, the board's own queue
 * and worker times, so a gate recorded before spans existed still shows where its time went. `requeue` is the time
 * between one job's infrastructure end and its retry job's queue time.
 *
 * @param {object[]} jobs - The chain's records.
 * @param {Map<string, object[]>} spansByJob
 * @returns {Map<string, number>} Milliseconds by phase.
 */
function gatePhases(jobs, spansByJob) {
  const phases = new Map();
  const add = (phase, ms) => { if (Number.isFinite(ms) && ms >= 0) phases.set(phase, (phases.get(phase) ?? 0) + ms); };
  jobs.forEach((job, index) => { if (index) add('requeue', Date.parse(job.at) - Date.parse(jobs[index - 1].completedAt)); });
  for (const job of jobs) {
    const spans = (spansByJob.get(job.id) ?? []).filter(span => span.phase !== 'gate');
    for (const span of spans) add(span.phase, span.ms);
    if (!spans.some(span => span.phase === 'queued')) add('queued', Date.parse(job.startedAt) - Date.parse(job.at));
    if (!spans.length) add('worker', Date.parse(job.completedAt) - Date.parse(job.startedAt));
  }
  return phases;
}

/**
 * Summarise the gates that ended in the window, and the phase spans recorded for them.
 *
 * @param {{ records: object[], spans: object[], since: number, now: number }} input - `records` are hand-off job records
 *   (the chain of any job in the window included); `spans` are the span lines read for the window.
 * @returns {{ since: string, asOf: string, gates: number, live: number, spanned: number, total: { p50: number|null, p90: number|null },
 *   phases: object[], causes: object[], slowest: object[] }}
 */
export function gateHealthSummary({ records, spans, since, now }) {
  const spansByJob = new Map();
  for (const span of spans) {
    if (!spansByJob.has(span.job)) spansByJob.set(span.job, []);
    spansByJob.get(span.job).push(span);
  }
  const gates = [];
  let live = 0;
  for (const jobs of chains(records)) {
    const last = jobs.at(-1);
    if (LIVE_STATES.has(last.state)) { live += 1; continue; }
    const end = Date.parse(last.completedAt);
    if (!(end >= since && end <= now)) continue;
    const start = Date.parse(jobs[0].at);
    gates.push({ item: last.item ?? null, job: last.id, jobs, state: last.state, code: last.error?.code ?? null,
      totalMs: Math.max(0, end - start), phases: gatePhases(jobs, spansByJob), spanned: jobs.some(job => spansByJob.has(job.id)) });
  }
  const perPhase = new Map();
  for (const gate of gates) {
    for (const [phase, ms] of gate.phases) {
      if (!perPhase.has(phase)) perPhase.set(phase, []);
      perPhase.get(phase).push(ms);
    }
  }
  const phases = [...perPhase].map(([phase, values]) => ({ phase, gates: values.length, sumMs: values.reduce((a, b) => a + b, 0), p50Ms: percentile(values, 0.5) }))
    .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || a.phase.localeCompare(b.phase));
  const causes = new Map();
  /** Count one typed failure with its code and host. */
  const cause = (type, code, host) => {
    const key = `${type}\u0000${code ?? ''}`;
    if (!causes.has(key)) causes.set(key, { cause: type, code: code ?? null, count: 0, hosts: {} });
    const row = causes.get(key);
    row.count += 1;
    if (host) row.hosts[host] = (row.hosts[host] ?? 0) + 1;
  };
  for (const gate of gates) {
    for (const job of gate.jobs) {
      for (const span of spansByJob.get(job.id) ?? []) if (span.cause && span.phase !== 'gate') cause(span.cause, span.code, span.host === 'local' ? null : span.host);
      // A job that ended on infrastructure was rerun as a new job: one infra retry, typed by its code when known.
      if (job.state === 'infrastructure') cause(RECORD_CAUSES[job.error?.code] ?? 'infra-retry', job.error?.code ?? job.requeuedFor ?? null, null);
    }
  }
  const slowest = [...gates].sort((a, b) => b.totalMs - a.totalMs).slice(0, 10).map(gate => {
    const [phase, ms] = [...gate.phases].sort((a, b) => b[1] - a[1])[0] ?? ['unrecorded', gate.totalMs];
    return { item: gate.item, job: gate.job, state: gate.state, code: gate.code, totalMs: gate.totalMs, attempts: gate.jobs.length,
      spanned: gate.spanned, dominant: { phase, ms } };
  });
  return { since: new Date(since).toISOString(), asOf: new Date(now).toISOString(), gates: gates.length, live,
    spanned: gates.filter(gate => gate.spanned).length,
    total: { p50: percentile(gates.map(gate => gate.totalMs), 0.5), p90: percentile(gates.map(gate => gate.totalMs), 0.9) },
    phases, causes: [...causes.values()].sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause) || String(a.code).localeCompare(String(b.code))), slowest };
}

/** A duration in the report's short form: 950ms, 42s, 12m05s or 1h02m. */
function shortDuration(ms) {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * The report's text lines.
 *
 * @param {ReturnType<typeof gateHealthSummary>} report
 * @param {string} window - The window as the person gave it, such as 2h.
 * @returns {string[]}
 */
export function gateHealthLines(report, window) {
  const lines = [`gate health, last ${window} (${report.since} to ${report.asOf})`,
    `${report.gates} gates ended (${report.spanned} with phase spans), ${report.live} still queued or running; total p50 ${shortDuration(report.total.p50)}, p90 ${shortDuration(report.total.p90)}`];
  if (!report.gates) return lines;
  lines.push('', 'time per phase (spans overlap; each phase is summed over the gates that have it):');
  for (const row of report.phases) lines.push(`  ${row.phase.padEnd(16)} ${String(row.gates).padStart(4)} gates  sum ${shortDuration(row.sumMs).padStart(7)}  p50 ${shortDuration(row.p50Ms).padStart(7)}`);
  lines.push('', 'top failure causes:');
  if (!report.causes.length) lines.push('  none');
  for (const row of report.causes.slice(0, 10)) {
    const hosts = Object.entries(row.hosts).sort((a, b) => b[1] - a[1]).map(([host, count]) => `${host} ${count}`).join(', ');
    lines.push(`  ${row.cause}${row.code ? ` ${row.code}` : ''}: ${row.count}${hosts ? ` (${hosts})` : ''}`);
  }
  lines.push('', 'slowest gates:');
  for (const gate of report.slowest) {
    lines.push(`  #${gate.item ?? '?'} ${shortDuration(gate.totalMs).padStart(7)} ${gate.state}${gate.code ? ` ${gate.code}` : ''}${gate.attempts > 1 ? `, ${gate.attempts} attempts` : ''}; most time in ${gate.dominant.phase} ${shortDuration(gate.dominant.ms)}${gate.spanned ? '' : ' (board times only)'}`);
  }
  return lines;
}
