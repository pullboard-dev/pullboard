/**
 * What a red pulled gate keeps of its output, so its receipt names the cause after the runner's checkout is gone [P7].
 * Each function here is self-contained, with no import or outer name, because the gate job's entry carries its source
 * text to the runner (apps/cli/src/io/submit/pull.js) and runs it there beside main's tooling.
 */

/**
 * Every failing case a TAP stream reports, with the error its YAML block gives: file (relative to root), name and
 * error text. Parent rows that only count failed subtests are left out, since their cases carry the errors. Why
 * apart from the accounted failures: a run whose TAP does not account for every failure still names what did fail.
 *
 * @param {string} text - The phase's output.
 * @param {string} root - The checkout the phase ran in; locations under it are made relative.
 * @param {{ cases?: number, errorBytes?: number }} [limits] - At most `cases` rows, each error cut to `errorBytes` characters.
 * @returns {Array<{ file: string | null, name: string, error: string }>}
 */
export function tapCaseErrors(text, root, { cases = 100, errorBytes = 600 } = {}) {
  const lines = String(text).split('\n'), rows = [];
  const unquote = value => {
    const trimmed = value.trim();
    if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) return trimmed.slice(1, -1).replaceAll("''", "'");
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) { try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); } }
    return trimmed;
  };
  for (let index = 0; index < lines.length && rows.length < cases; index++) {
    const failed = /^(\s*)not ok\s+\d+\s+-\s+(.*)$/u.exec(lines[index]);
    if (!failed) continue;
    const row = { file: null, name: failed[2].replace(/\s+#.*$/u, ''), error: '' };
    let aggregate = false;
    const open = /^(\s*)---\s*$/u.exec(lines[index + 1] ?? '');
    if (open) {
      const indent = open[1];
      let at = index + 2;
      for (; at < lines.length && lines[at] !== `${indent}...`; at++) {
        const field = /^(\s*)([A-Za-z_]+):\s?(.*)$/u.exec(lines[at]);
        if (!field || field[1] !== indent) continue;
        const [, , key, value] = field;
        if (key === 'location') {
          const path = unquote(value).replace(/:\d+(?::\d+)?$/u, '');
          row.file = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\.\//u, '');
        } else if (key === 'failureType') aggregate = unquote(value) === 'subtestsFailed';
        else if (key === 'error') {
          if (/^[|>][-+]?\s*$/u.test(value)) {
            // A block scalar: the lines indented past the field are the error, in order.
            const block = [];
            while (at + 1 < lines.length && lines[at + 1].startsWith(`${indent}  `)) block.push(lines[++at].slice(indent.length + 2));
            row.error = block.join('\n');
          } else row.error = unquote(value);
        }
      }
      index = at;
    }
    if (aggregate) continue;
    row.error = row.error.length > errorBytes ? `${row.error.slice(0, errorBytes)}…` : row.error;
    row.name = row.name.slice(0, 500);
    rows.push(row);
  }
  return rows;
}

/**
 * The last lines of a phase's output that say why it exited, with the run's closing counts, timing frames, phase line,
 * Node warnings and blank lines left out. Why: those trailers fill the end of every run, so a plain tail of a crashed
 * or killed proof can end on counts that name nothing.
 *
 * @param {string} text
 * @param {{ lines?: number, bytes?: number }} [limits] - At most this many lines and characters, newest kept.
 * @returns {string}
 */
export function exitLines(text, { lines = 40, bytes = 3000 } = {}) {
  const noise = [/^\s*$/u, /^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d+(?:\.\d+)?\s*$/u, /^# pullboard /u, /^run-tests: phases /u,
    /^\s*1\.\.\d+\s*$/u, /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?[A-Za-z]*Warning: /u, /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/u];
  const kept = [];
  let size = 0;
  const all = String(text).split('\n');
  for (let index = all.length - 1; index >= 0 && kept.length < lines; index--) {
    if (noise.some(pattern => pattern.test(all[index]))) continue;
    const room = bytes - size - 1;
    if (room < 1) break;
    // A line longer than the room left keeps its end, where an error's own words usually are.
    const line = all[index].length > room ? `…${all[index].slice(-(room - 1))}` : all[index];
    kept.unshift(line); size += line.length + 1;
  }
  return kept.join('\n');
}

/**
 * Shrink a gate receipt until its JSON fits `limit` bytes: case errors first, then the case lists, then each phase's
 * tail and exit lines. Why: the runner posts the receipt line whole only under its cap, and the board refuses a
 * receipt over 64 KiB (packages/api/src/io/jobs.js), so a long red must lose detail, never its receipt.
 *
 * @param {Record<string, any>} receipt - Changed in place.
 * @param {number} limit
 * @returns {Record<string, any>}
 */
export function fitReceipt(receipt, limit) {
  const size = () => Buffer.byteLength(JSON.stringify(receipt));
  const phases = Array.isArray(receipt.phases) ? receipt.phases : [];
  for (let cut = 300; size() > limit && cut >= 40; cut = Math.floor(cut / 2)) {
    for (const phase of phases) for (const row of phase.errors ?? []) if (row.error.length > cut) row.error = `${row.error.slice(0, cut)}…`;
  }
  while (size() > limit && phases.some(phase => (phase.errors ?? []).length > 1)) {
    for (const phase of phases) if ((phase.errors ?? []).length > 1) phase.errors = phase.errors.slice(0, Math.ceil(phase.errors.length / 2));
  }
  for (let keep = 2000; size() > limit && keep >= 50; keep = Math.floor(keep / 2)) {
    for (const phase of phases) for (const key of ['tail', 'exit']) if (typeof phase[key] === 'string' && phase[key].length > keep) phase[key] = phase[key].slice(-keep);
  }
  return receipt;
}
