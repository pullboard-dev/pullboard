/** Two-minute file cap: a gate takes as long as its slowest test file, so no file may grow past it [C7]. */
export const FILE_RUNTIME_CAP_MS = 120_000;

/** Name the cut that halves a file's measured test time, or a generic seam when no per-test times exist. */
export function splitSeam(tests = []) {
  const rows = tests.filter(row => typeof row?.name === 'string' && Number.isFinite(row.durationMs) && row.durationMs >= 0);
  const total = rows.reduce((sum, row) => sum + row.durationMs, 0);
  if (rows.length < 2 || total <= 0) return 'split along its top-level describe/test groups into files of under 2 minutes each';
  let seen = 0;
  for (let index = 0; index < rows.length - 1; index += 1) {
    seen += rows[index].durationMs;
    if (seen * 2 >= total) return `cut after test ${index + 1} of ${rows.length} ("${rows[index].name}"), which puts ${Math.round(seen / 1000)}s in the first file and ${Math.round((total - seen) / 1000)}s in the second`;
  }
  return `cut before the last test ("${rows[rows.length - 1].name}")`;
}

/**
 * Decide one file. A candidate adds too much when the file crosses the cap from at or under it, or grows by more
 * than the cap itself; a file already over the cap that does not grow is only listed. An unknown baseline is listed, never refused.
 */
export function fileRuntimeCapFailure(file, afterMs, beforeMs, tests = [], cap = FILE_RUNTIME_CAP_MS) {
  if (!Number.isFinite(afterMs) || afterMs < 0) throw new TypeError(`missing test file runtime for ${file}`);
  if (!Number.isFinite(cap) || cap <= 0) throw new TypeError('file runtime cap must be a positive finite number of milliseconds');
  if (afterMs <= cap || !Number.isFinite(beforeMs)) return null;
  const adds = afterMs - beforeMs;
  if (beforeMs > cap && adds <= cap) return null;
  return `${file} now takes ${Math.ceil(afterMs / 1000)}s (was ${Math.ceil(beforeMs / 1000)}s, +${Math.ceil(adds / 1000)}s), over the ${cap / 1000}s file cap; split seam: ${splitSeam(tests)}`;
}

/** Apply the cap to a candidate's measured files against the receipts' last runtimes; list files already over it. */
export function fileRuntimeCapReport(candidate, before, cap = FILE_RUNTIME_CAP_MS) {
  const refusals = [];
  for (const [file, row] of Object.entries(candidate)) {
    const ms = typeof row === 'number' ? row : row.durationMs;
    const message = fileRuntimeCapFailure(file, ms, before[file], typeof row === 'number' ? [] : row.tests, cap);
    if (message) refusals.push({ file, message });
  }
  const over = Object.entries(before).filter(([, ms]) => Number.isFinite(ms) && ms > cap).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file, ms]) => ({ file, durationMs: ms }));
  return { cap, refusals, over, ok: refusals.length === 0 };
}

/** Render the check output: refusals first, then every existing file over the cap so split items can be filed. */
export function fileRuntimeCapOutput(report) {
  const lines = report.refusals.map(row => `file runtime cap: ${row.message}`);
  if (report.over.length) lines.push(`files over ${report.cap / 1000}s today (split items needed):`, ...report.over.map(row => `  ${row.file}: ${Math.ceil(row.durationMs / 1000)}s`));
  return lines.join('\n');
}
