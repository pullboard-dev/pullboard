import { blockingFailures } from '../../../../verify/index.js';
/** Match completely accounted test failures without granting a file-wide main-red exemption [V4,B3]. */
import { createHash } from 'node:crypto';
import { secretsIn } from '../../../../commits/index.js';
import { realpathSync } from 'node:fs';
import { accountedFailures } from '../land.js';
import { failureSignature } from '../../../../gate/index.js';
import { classifyMainRed } from '../../../../receipt/index.js';
import { comparisonStatus } from '../../../../receipt/index.js';
import {
  MAIN_FAILURE_SIGNATURE_VERSION,
  normalizedFailureDiagnostics,
} from '../../logic/main/noise.js';

export { MAIN_FAILURE_SIGNATURE_VERSION } from '../../logic/main/noise.js';

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
      active = { name: start[2].replace(/\s+#.*$/u, ''), indent: start[1].length + 2, lines: [], all: [] };
      rows.push(active); omitted = false; continue;
    }
    if (!embedded && /^\s*ok\s+\d+/u.test(line)) { active = null; continue; }
    if (!active || !line.startsWith(' '.repeat(active.indent))) continue;
    const value = line.slice(active.indent);
    active.all.push(value);
    if (value === '...') active.done = true;
    if (/^(?:duration_ms|location|stack):/u.test(value)) { omitted = true; continue; }
    if (/^[\w-]+:/u.test(value)) omitted = false;
    if (!omitted && value !== '---' && value !== '...') active.lines.push(value);
  }
  return rows.map(row => ({ ...row, ...stableFailure(row.all, root),
    signature: row.lines.some(line => line.startsWith('error:')) && row.lines.some(line => line.startsWith('failureType:'))
      ? createHash('sha256').update(JSON.stringify([MAIN_FAILURE_SIGNATURE_VERSION, normalizedFailureDiagnostics(row.lines, root)])).digest('hex') : null }));
}

/** Read one failure's `key: value` and `key: |-` fields from its diagnostics, before any are dropped as noise. */
function diagnosticFields(all) {
  const fields = {};
  for (let index = 0; index < all.length; index += 1) {
    const field = /^([\w-]+):\s?(.*)$/u.exec(all[index]);
    if (!field) continue;
    let value = field[2];
    if (/^[|>][-+]?$/u.test(value)) {
      const block = [];
      while (index + 1 < all.length && /^\s/u.test(all[index + 1])) block.push(all[++index].replace(/^ {2}/u, ''));
      value = block.join('\n');
    } else value = value.replace(/^(['"])(.*)\1$/u, '$2');
    fields[field[1]] = value;
  }
  return fields;
}

/**
 * The stable failure signature of one failure's diagnostics (null when no repository frame names it), and a digest of its
 * asserted values: a changed expected or actual value is a different failure at the same frame, not run noise [C7].
 */
function stableFailure(all, root) {
  const { error, stack, name, code, operator, expected, actual } = diagnosticFields(all);
  const stable = failureSignature({ error, stack, name, code, operator, root });
  if (!stable) return {};
  const values = normalizedFailureDiagnostics([`expected: ${expected ?? ''}`, `actual: ${actual ?? ''}`], root);
  return { stable, stableData: createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16) };
}

/** Extract the first safe diagnostic line without changing the failure signature. */
function firstError(lines, root) {
  const index = lines.findIndex(line => line.startsWith('error:'));
  if (index < 0) return null;
  let value = lines[index].slice('error:'.length).trim();
  if (!value || /^[|>][-+]?$/u.test(value)) value = lines.slice(index + 1).find(line => line.trim())?.trim() ?? '';
  value = value.replace(/^['"]|['"]$/gu, '');
  // Normalize before truncating so varying checkout path lengths cannot change the retained prefix.
  value = normalizedFailureDiagnostics([`error: ${value}`], root)[0].slice('error: '.length).slice(0, 1024);
  if (!value) return null;
  return secretsIn([{ path: 'main failure output', line: 1, text: value }]).length ? '[redacted error]' : value;
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
export function failureSignatures(run, root, { raw = false, allowCancelled = false } = {}) {
  let executionRoot = run.executionRoot ?? root;
  if (!run.executionRunner) {
    try { executionRoot = realpathSync(executionRoot); }
    catch { /* An unavailable path cannot invent a failure location. */ }
  }
  const failures = accountedFailures({ ...run, ...(raw ? { isGreen: run.rawIsGreen ?? run.isGreen } : {}), executionRoot }, executionRoot, { nativeLeaves: Boolean(run.blockingVerdict), allowCancelled });
  if (!failures) return null;
  const stages = run.stages.flatMap(stage => stage.pipeline ?? [stage]);
  const details = stages.filter(stage => stage.status !== 0).flatMap(stage => diagnostics(stage.output ?? '', executionRoot))
    .filter(row => !allowCancelled || !row.lines.some(line => /^failureType:\s*['"]?cancelledByParent['"]?\s*$/u.test(line)))
    .filter(row => !run.blockingVerdict || !row.lines.some(line => /^failureType:\s*['"]?subtestsFailed['"]?\s*$/u.test(line)));
  if (details.length !== failures.length) return null;
  const signed = failures.map((failure, index) => ({ ...failure, signature: details[index].name === failure.name ? details[index].signature : null }))
    .every(row => row.file && row.signature) ? failures.map((failure, index) => {
      const error = firstError(details[index].lines, executionRoot);
      return { ...failure, signature: details[index].signature, ...(error ? { firstError: error } : {}), ...(details[index].stable ? { stable: details[index].stable, stableData: details[index].stableData } : {}) };
    }) : null;
  return signed ? raw ? signed : blockingFailures(run, signed) : null;
}

/** Every actual candidate failure must match the exact main test and its failure details. */
export function matchingMainFailures(failures, comparison, main, { byCase = false } = {}) {
  if (!failures?.length || comparison.main !== main || comparison.unavailable) return null;
  for (const failure of failures) {
    if (typeof failure.file !== 'string' || !failure.file || /[:\\\p{Cc}]/u.test(failure.file)
      || failure.file.split('/').some(part => !part || part === '.' || part === '..')) return null;
    // A case defined in a helper reports the helper as its file; main ran it under the test file that imports the helper.
    const file = comparison.files.find(row => row.file === failure.file)
      ?? comparison.files.find(row => row.failures?.some(main => main.file === failure.file && main.name === failure.name));
    if (file?.result === 'red' && file.fileIsolation === true && file.file === failure.file) continue;
    const matches = file?.failures?.filter(row => row.file === failure.file && row.name === failure.name);
    // Landing asks only whether main fails this exact case: a case red on main cannot be one the item broke, however its
    // run-specific details (checkout paths, timings) read. Submit and verify keep the exact failure signature [C7,#3073].
    // The receipt lookup decides ownership: a case is main's own only when main's receipt for the file names it [C7,#3424].
    if (classifyMainRed([failure.name], comparisonStatus(file, failure.file)).owner !== 'main') return null;
    if (matches?.length !== 1 || (!byCase && matches[0].signature !== failure.signature)) return null;
  }
  return { main, failures };
}
