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
 * @param {{ cases?: number, errorBytes?: number }} [limits] - At most `cases` rows (every case by default), each error cut to
 *   `errorBytes` characters. Why every case: a red with many failures must still name each one [P7,#5828].
 * @returns {Array<{ file: string | null, name: string, error: string }>}
 */
export function tapCaseErrors(text, root, { cases = Infinity, errorBytes = 600 } = {}) {
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
    // Node's reporter writes # in a name as \# and a backslash as \\; undo that after the directive is cut, so the name matches the outcomes record.
    const row = { file: null, name: failed[2].replace(/\s+#.*$/u, '').replace(/\\([\\#])/gu, '$1'), error: '' };
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
 * The files Node's native spec reporter names in its failure footer: after the line `✖ failing tests:`, each failure
 * starts `test at <file>:<line>:<col>`. Colour codes are ignored; a location under root is made relative, and one
 * outside it, or a location printed anywhere but the footer, names no file. Why: a spec-reported red has no TAP account,
 * so its cases cannot be named, yet the footer still says which files failed, so the board can compare them with main [V1,C7].
 *
 * @param {string} text - The phase's output.
 * @param {string} root - The checkout the phase ran in.
 * @param {{ files?: number }} [limits] - At most this many files.
 * @returns {string[]} The failed files, sorted; none when the output has no footer.
 */
export function specFailureFiles(text, root, { files = 100 } = {}) {
  const found = new Set();
  let footer = false;
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '').trim();
    if (line === '✖ failing tests:') { footer = true; continue; }
    const at = footer ? /^test at (.+):\d+:\d+$/u.exec(line) : null;
    if (!at) continue;
    let path = at[1].startsWith('file://') ? decodeURIComponent(at[1].slice('file://'.length)) : at[1];
    if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
    path = path.replace(/^(?:\.\/)+/u, '');
    if (path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..') && found.size < files) found.add(path);
  }
  return [...found].sort();
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
 * Shrink a gate receipt until its JSON fits `limit` bytes: each phase's tail and exit lines, then case errors down to
 * none, then case rows from the end. Every phase with errors keeps `errorCount`, its whole number of failing cases,
 * and a phase that drops rows says how many in `errorsOmitted`; its `errorsKept` file on the runner lists them all.
 * Why: the runner posts the receipt line whole only under its cap, and the board refuses a receipt over 64 KiB
 * (packages/api/src/io/jobs.js), so a long red must lose detail, never its receipt, and never hide a case [#5828].
 *
 * @param {Record<string, any>} receipt - Changed in place.
 * @param {number} limit
 * @returns {Record<string, any>}
 */
export function fitReceipt(receipt, limit) {
  const size = () => Buffer.byteLength(JSON.stringify(receipt));
  const phases = Array.isArray(receipt.phases) ? receipt.phases : [];
  for (const phase of phases) if (Array.isArray(phase.errors)) phase.errorCount ??= phase.errors.length;
  // Per-case outcomes are all or nothing: a partial list would read as cases the phase never ran, so a receipt over its cap drops them first.
  for (const phase of phases) if (size() > limit && phase.testOutcomes) delete phase.testOutcomes;
  // The runtime rows are all or nothing for the same reason, and drop with them.
  for (const phase of phases) if (size() > limit && phase.testRuntimes) delete phase.testRuntimes;
  for (let keep = 2000; size() > limit && keep >= 50; keep = Math.floor(keep / 2)) {
    for (const phase of phases) for (const key of ['tail', 'exit']) if (typeof phase[key] === 'string' && phase[key].length > keep) phase[key] = phase[key].slice(-keep);
  }
  for (const cut of [300, 150, 75, 40, 20, 0]) {
    if (size() <= limit) break;
    for (const phase of phases) for (const row of phase.errors ?? []) if (row.error.length > cut) row.error = cut > 0 ? `${row.error.slice(0, cut)}…` : '';
  }
  // Rows go last, from the end, so the receipt names as many cases as fit and counts the rest.
  while (size() > limit && phases.some(phase => (phase.errors ?? []).length)) {
    for (const phase of phases) {
      if (!(phase.errors ?? []).length) continue;
      phase.errors = phase.errors.slice(0, Math.floor(phase.errors.length * 0.9));
      phase.errorsOmitted = phase.errorCount - phase.errors.length;
    }
  }
  return receipt;
}
