/** Shared wire-proof validation for preparation and ordered replay [C7,V4,H16]. */
import { Refused } from '../../../../src/refused.js';
import { KNOWN_MAIN_FAILURES_ENGINE } from '../../../../src/known-main-failures-engine.js';
import { KNOWN_MAIN_REWORKS_ENGINE } from '../../../../src/known-main-reworks-engine.js';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Accept only literal project-relative paths that can be displayed and configured safely. */
function projectFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[:\\\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/**
 * Bound a submit's selection reason to what a submission proof stores, declaring what it cut: every selected and
 * deferred file is recorded in full beside it, so only the prose explanation shortens (#1605, #1648, #1651).
 */
export function boundedProofReason(reason) {
  if (reason.length <= 8192) return reason;
  return `${reason.slice(0, 8000)} ... (+${reason.length - 8000} characters elided; every selected and deferred file is recorded in full in this proof)`;
}

/** Normalize the receipt required by modern submits; legacy replay skips this guard. */
export function submissionProof(value, engine = KNOWN_MAIN_REWORKS_ENGINE) {
  if (!value || value.version !== 1 || typeof value.full !== 'boolean'
    || typeof value.deferred !== 'boolean' || typeof value.reason !== 'string'
    || value.reason.length > 8192 || !Array.isArray(value.files) || value.files.some(file => !projectFile(file))
    || value.deferredFiles !== undefined && (!value.deferred || !Array.isArray(value.deferredFiles) || value.deferredFiles.some(file => !projectFile(file)))) {
    throw new Refused('SUBMISSION_PROOF', 'a submission proof needs its version, selected project files, full-fallback reason and deferred flag; rerun submit with the current CLI');
  }
  const known = value.knownMainFailures;
  if (known !== undefined && (engine < KNOWN_MAIN_FAILURES_ENGINE || !known || !COMMIT.test(known.main ?? '')
    || !Array.isArray(known.failures) || !known.failures.length || known.failures.some(row => !projectFile(row?.file)
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || !/^[a-f0-9]{64}$/u.test(row.signature ?? '')))) {
    throw new Refused('SUBMISSION_PROOF', 'known main failures need their exact main commit, project test files, names and failure signatures on a supporting engine');
  }
  if (known && known.failures.some(row => engine >= KNOWN_MAIN_REWORKS_ENGINE
    ? !Number.isSafeInteger(row.item) || row.item < 1 : row.item !== undefined)) {
    throw new Refused('SUBMISSION_PROOF', 'known main failure repair links need positive item ids on a supporting engine; historical receipts keep their original format');
  }
  return { version: 1, files: [...new Set(value.files)].sort(), full: value.full,
    deferred: value.deferred, reason: value.reason, ...(value.deferredFiles ? { deferredFiles: [...new Set(value.deferredFiles)].sort() } : {}),
    ...(known ? { knownMainFailures: { main: known.main, failures: known.failures.map(({ file, name, signature, item }) => ({ file, name, signature,
      ...(item === undefined ? {} : { item }) })) } } : {}) };
}

