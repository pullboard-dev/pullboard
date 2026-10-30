import { blockingFailures } from './quarantine-verdict.js';
/** Match completely accounted test failures without granting a file-wide main-red exemption [V4,B3]. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { accountedFailures } from './land.js';
import {
  MAIN_FAILURE_SIGNATURE_VERSION,
  normalizedFailureDiagnostics,
} from './main-failure-noise.js';

export { MAIN_FAILURE_SIGNATURE_VERSION } from './main-failure-noise.js';

/** Keep deterministic failure diagnostics, excluding only timing, source location and stack presentation. */
function diagnostics(output, root) {
  const rows = [];
  let active;
  let omitted = false;
  for (const line of output.split('\n')) {
    const start = /^(\s*)not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    // A `not ok` or `ok` line indented inside the active failure's own diagnostics is text that failure printed, such as a
    // nested run's TAP; it is part of that failure, never a second failure or the end of this one (#2064).
    const embedded = active && !active.done && line.startsWith(' '.repeat(active.indent));
    if (start && !embedded) {
      active = { name: start[2].replace(/\s+#.*$/u, ''), indent: start[1].length + 2, lines: [] };
      rows.push(active); omitted = false; continue;
    }
    if (!embedded && /^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    if (!active || !line.startsWith(' '.repeat(active.indent))) continue;
    const value = line.slice(active.indent);
    if (value === '...') active.done = true;
    if (/^(?:duration_ms|location|stack):/u.test(value)) { omitted = true; continue; }
    if (/^[\w-]+:/u.test(value)) omitted = false;
    if (!omitted && value !== '---' && value !== '...') active.lines.push(value);
  }
  return rows.map(row => ({ ...row,
    signature: row.lines.some(line => line.startsWith('error:')) && row.lines.some(line => line.startsWith('failureType:'))
      ? createHash('sha256').update(JSON.stringify([MAIN_FAILURE_SIGNATURE_VERSION, normalizedFailureDiagnostics(row.lines, root)])).digest('hex') : null }));
}

/** Legacy coarse outcomes remain useful, but old detailed hashes cannot authorize equality under a new scheme. */
export function cachedFailureSignatures(outcome, file) {
  const failures = outcome.failures;
  if (!Array.isArray(failures) || failures.some(row => row?.file !== file && row?.ran !== file
    || typeof row.name !== 'string' || !row.name || !/^[a-f0-9]{64}$/u.test(row.signature))) return undefined;
  return outcome.signatureVersion === MAIN_FAILURE_SIGNATURE_VERSION || outcome.result === 'green' && failures.length === 0
    ? failures : undefined;
}

/** Null means some process failure or diagnostic cannot be accounted for; it never authorizes acceptance. */
export function failureSignatures(run, root, { raw = false } = {}) {
  let executionRoot = run.executionRoot ?? root;
  if (!run.executionRunner) {
    try { executionRoot = realpathSync(executionRoot); }
    catch { /* An unavailable path cannot invent a failure location. */ }
  }
  const accounted = accountedFailures({ ...run, ...(raw ? { isGreen: run.rawIsGreen ?? run.isGreen } : {}), executionRoot }, executionRoot, { nativeLeaves: Boolean(run.blockingVerdict) });
  if (!accounted) return null;
  const stages = run.stages.flatMap(stage => stage.pipeline ?? [stage]);
  const details = stages.filter(stage => stage.status !== 0).flatMap(stage => diagnostics(stage.output ?? '', executionRoot))
    .filter(row => !run.blockingVerdict || !row.lines.some(line => /^failureType:\s*['"]?subtestsFailed['"]?\s*$/u.test(line)));
  if (details.length !== accounted.length) return null;
  const failures = [], kept = [];
  for (const [index, failure] of accounted.entries()) {
    // A nested copy of a named case that reports no file inside this root is that case again, never a second failure (#2064).
    if (!failure.file && accounted.some(other => other.file && other.name === failure.name)) continue;
    if (failures.some(seen => seen.file === failure.file && seen.name === failure.name)) continue;
    failures.push(failure); kept.push(details[index]);
  }
  details.splice(0, details.length, ...kept);
  const signed = failures.map((failure, index) => ({ ...failure, signature: details[index].name === failure.name ? details[index].signature : null }))
    .every(row => row.file && row.signature) ? failures.map((failure, index) => ({ ...failure, signature: details[index].signature })) : null;
  return signed ? raw ? signed : blockingFailures(run, signed) : null;
}

/** Every actual candidate failure must match the exact main test and its failure details. */
export function matchingMainFailures(failures, comparison, main) {
  if (!failures?.length || comparison.main !== main || comparison.unavailable) return null;
  for (const failure of failures) {
    if (typeof failure.file !== 'string' || !failure.file || /[:\\\p{Cc}]/u.test(failure.file)
      || failure.file.split('/').some(part => !part || part === '.' || part === '..')) return null;
    // A case defined in a helper reports the helper as its file; main ran it under the test file that imports the helper.
    const file = comparison.files.find(row => row.file === failure.file)
      ?? comparison.files.find(row => row.failures?.some(main => main.file === failure.file && main.name === failure.name));
    const matches = file?.failures?.filter(row => row.file === failure.file && row.name === failure.name);
    if (file?.result !== 'red' || matches?.length !== 1 || matches[0].signature !== failure.signature) return null;
  }
  return { main, failures };
}
