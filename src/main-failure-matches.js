/** Match completely accounted test failures without granting a file-wide main-red exemption [V4,B3]. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { accountedFailures } from './land.js';

/** Keep deterministic failure diagnostics, excluding only timing, source location and stack presentation. */
function diagnostics(output, root) {
  const rows = [];
  let active;
  let omitted = false;
  for (const line of output.split('\n')) {
    const start = /^(\s*)not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (start) {
      active = { name: start[2].replace(/\s+#.*$/u, ''), indent: start[1].length + 2, lines: [] };
      rows.push(active); omitted = false; continue;
    }
    if (/^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    if (!active || !line.startsWith(' '.repeat(active.indent))) continue;
    const value = line.slice(active.indent);
    if (/^(?:duration_ms|location|stack):/u.test(value)) { omitted = true; continue; }
    if (/^[\w-]+:/u.test(value)) omitted = false;
    if (!omitted && value !== '---' && value !== '...') active.lines.push(value.replaceAll(root, '<root>'));
  }
  return rows.map(row => ({ ...row,
    signature: row.lines.some(line => line.startsWith('error:')) && row.lines.some(line => line.startsWith('failureType:'))
      ? createHash('sha256').update(row.lines.join('\n')).digest('hex') : null }));
}

/** Null means some process failure or diagnostic cannot be accounted for; it never authorizes acceptance. */
export function failureSignatures(run, root) {
  let executionRoot = run.executionRoot ?? root;
  if (!run.executionRunner) {
    try { executionRoot = realpathSync(executionRoot); }
    catch { /* An unavailable path cannot invent a failure location. */ }
  }
  const failures = accountedFailures({ ...run, executionRoot }, executionRoot);
  if (!failures) return null;
  const stages = run.stages.flatMap(stage => stage.pipeline ?? [stage]);
  const details = stages.filter(stage => stage.status !== 0).flatMap(stage => diagnostics(stage.output ?? '', executionRoot));
  if (details.length !== failures.length) return null;
  return failures.map((failure, index) => ({ ...failure, signature: details[index].name === failure.name ? details[index].signature : null }))
    .every(row => row.file && row.signature) ? failures.map((failure, index) => ({ ...failure, signature: details[index].signature })) : null;
}

/** Every actual candidate failure must match the exact main test and its failure details. */
export function matchingMainFailures(failures, comparison, main) {
  if (!failures?.length || comparison.main !== main || comparison.unavailable) return null;
  for (const failure of failures) {
    const file = comparison.files.find(row => row.file === failure.file);
    const matches = file?.failures?.filter(row => row.file === failure.file && row.name === failure.name);
    if (file?.result !== 'red' || matches?.length !== 1 || matches[0].signature !== failure.signature) return null;
  }
  return { main, failures };
}
