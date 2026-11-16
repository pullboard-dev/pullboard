/** A run of red submit gates whose failures no one can name is a broken gate, not broken work [C7]. */

/** The window in which unaccounted reds are counted. */
export const UNACCOUNTED_RED_WINDOW_MS = 60 * 60_000;
/** Unaccounted reds in the window that raise the shout on their own. */
export const UNACCOUNTED_RED_COUNT = 3;
/** The share of reds in the window that raises the shout, as a fraction. */
export const UNACCOUNTED_RED_SHARE = 0.2;

/** The text submit appends to a red it could not name failure by failure. */
const UNACCOUNTED_NOTE = 'known-main acceptance unavailable';
/** Lines that are the gate's own framing, not output the parser failed to read. */
const FRAMING = /^(?:the submission proof is red\b|known-main acceptance unavailable\b|known main\b|not ok\b|ok\b|#|\s*$)/u;

/**
 * Whether a red gate's failures are unaccounted: the refusal says known-main acceptance was unavailable, because the
 * proof had no complete named failure account.
 *
 * Why this signal: it is the exact refusal the 5 Nov parser break produced on every red for three days (#3794).
 *
 * @param {{ error?: { code?: string, message?: string } }} record - A hand-off record in the red state.
 * @returns {boolean}
 */
export function redIsUnaccounted(record) {
  return record?.error?.code === 'GATE_RED' && String(record.error.message ?? '').includes(UNACCOUNTED_NOTE);
}

/**
 * The first line of a red's message the gate's parser did not account for, or the unavailable note itself.
 *
 * @param {string} message - The red refusal's message.
 * @returns {string}
 */
export function firstUnparsedLine(message) {
  const lines = String(message ?? '').split('\n');
  return (lines.find(line => !FRAMING.test(line)) ?? lines.find(line => line.includes(UNACCOUNTED_NOTE)) ?? '').trim().slice(0, 200);
}

/**
 * Health findings for red submit gates in the last hour: one finding, raised when three or more reds are unaccounted
 * or more than 20 percent of the reds are, naming the gates and the first unparsed line. Fully accounted reds raise
 * nothing. The finding keeps one key and starts at the oldest unaccounted red, so the sentinel shouts it once.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle, read only.
 * @param {Date} now
 * @returns {{ key: string, cause: string, item: null, subject: string, title: string, since: string, why: string, next: string,
 *   command: null, owner: { role: 'coordinator', who: 'coordinator' }, detail: object }[]}
 */
export function unaccountedRedFindings(db, now) {
  const at = now.getTime();
  let rows;
  try {
    rows = db.prepare(`SELECT j.job_id AS job, j.job_item AS item, s.job_step_payload AS payload, s.job_step_at AS at
      FROM job j JOIN job_step s ON s.job_step_id = (SELECT MAX(job_step_id) FROM job_step WHERE job_step_job = j.job_id AND job_step_name NOT LIKE 'note:%')
      WHERE j.job_kind = 'gate' AND j.job_updated >= ?`).all(at - UNACCOUNTED_RED_WINDOW_MS);
  } catch (error) { if (/no such table/u.test(error.message)) return []; throw error; }
  const reds = rows.flatMap(row => {
    let record;
    try { record = JSON.parse(row.payload).record; } catch { return []; }
    const when = Date.parse(record?.completedAt ?? '') || row.at;
    if (record?.state !== 'red' || !(when >= at - UNACCOUNTED_RED_WINDOW_MS && when <= at)) return [];
    return [{ job: row.job, item: row.item, when, unaccounted: redIsUnaccounted(record), message: record.error?.message }];
  });
  const lost = reds.filter(red => red.unaccounted).sort((a, b) => a.when - b.when || a.job.localeCompare(b.job));
  if (!lost.length || lost.length < UNACCOUNTED_RED_COUNT && lost.length / reds.length <= UNACCOUNTED_RED_SHARE) return [];
  const gates = lost.map(red => (red.item ? `#${red.item}` : red.job));
  const line = firstUnparsedLine(lost[0].message);
  return [{ key: 'UNACCOUNTED_REDS', cause: 'UNACCOUNTED_REDS', item: null, subject: `${lost.length} of ${reds.length} red gates`,
    title: 'came back with failures no one can name', since: new Date(lost[0].when).toISOString(),
    why: `red gates ${gates.join(', ')} in the last hour have no named failure account; first unparsed line: ${line || 'none printed'}`,
    next: 'read the first red gate\'s output for the line the parser does not account for, then fix the gate parser (packages/gate/light.js tapFailures)',
    command: null, owner: { role: 'coordinator', who: 'coordinator' }, detail: { gates, unparsed: line } }];
}
