/** Shared wire-proof validation for preparation and ordered replay [C7,V4,H16]. */
import { engineNumber } from '../engine/number.js';
import { Refused } from '../../../../kernel/browser.js';
const MAIN_RED_FAILURE_LINES_ENGINE = engineNumber('MAIN_RED_FAILURE_LINES_ENGINE');
const KNOWN_MAIN_FAILURES_ENGINE = engineNumber('KNOWN_MAIN_FAILURES_ENGINE');
const KNOWN_MAIN_REWORKS_ENGINE = engineNumber('KNOWN_MAIN_REWORKS_ENGINE');
const KNOWN_MAIN_RUNNING_FILE_ENGINE = engineNumber('KNOWN_MAIN_RUNNING_FILE_ENGINE');
const KNOWN_MAIN_RECEIPT_ENGINE = engineNumber('KNOWN_MAIN_RECEIPT_ENGINE');

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Accept only literal project-relative paths that can be displayed and configured safely. */
function projectFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[:\\\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** A main receipt id a known main failure cites: one bounded single line (a run id or a main-test job id). */
function receiptId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

/** The failure details a known main failure keeps beside its signature (first error line, stable signature and asserted values), each a bounded single line. */
function failureDetails({ firstError, stable, stableData }, engine) {
  if (engine < MAIN_RED_FAILURE_LINES_ENGINE) return {};
  const keep = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value);
  return { ...(keep(firstError, 1024) ? { firstError } : {}), ...(keep(stable, 1024) ? { stable } : {}), ...(keep(stableData, 64) ? { stableData } : {}) };
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
    || value.deferredFiles !== undefined && (!value.deferred || !Array.isArray(value.deferredFiles) || value.deferredFiles.some(file => !projectFile(file)))
    || value.owedFiles !== undefined && (!Array.isArray(value.owedFiles) || value.owedFiles.some(file => !projectFile(file)))) {
    throw new Refused('SUBMISSION_PROOF', 'a submission proof needs its version, selected project files, full-fallback reason and deferred flag; rerun submit with the current CLI');
  }
  const known = value.knownMainFailures;
  if (known !== undefined && (engine < KNOWN_MAIN_FAILURES_ENGINE || !known || !COMMIT.test(known.main ?? '')
    || !Array.isArray(known.failures) || !known.failures.length || known.failures.some(row => !projectFile(row?.file)
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || !/^[a-f0-9]{64}$/u.test(row.signature ?? '')
      || row.ran !== undefined && (engine < KNOWN_MAIN_RUNNING_FILE_ENGINE || !projectFile(row.ran))
      || row.receipt !== undefined && (engine < KNOWN_MAIN_RECEIPT_ENGINE || !receiptId(row.receipt))))) {
    throw new Refused('SUBMISSION_PROOF', 'known main failures need their exact main commit, project test files, names and failure signatures on a supporting engine');
  }
  if (known && known.failures.some(row => engine >= KNOWN_MAIN_REWORKS_ENGINE
    ? !Number.isSafeInteger(row.item) || row.item < 1 : row.item !== undefined)) {
    throw new Refused('SUBMISSION_PROOF', 'known main failure repair links need positive item ids on a supporting engine; historical receipts keep their original format');
  }
  // Cases red on main with several candidate repairs never fail the gate; the proof names each with its candidates (#2528, #7373).
  const ambiguous = value.knownMainAmbiguous;
  if (ambiguous !== undefined && (engine < KNOWN_MAIN_REWORKS_ENGINE || !Array.isArray(ambiguous) || !ambiguous.length || ambiguous.some(row => !projectFile(row?.file)
    || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || !Array.isArray(row.candidates) || row.candidates.length < 2
    || row.candidates.some(item => !Number.isSafeInteger(item) || item < 1)))) {
    throw new Refused('SUBMISSION_PROOF', 'known main cases with several candidate repairs need their project test file, name and two or more positive repair ids on a supporting engine');
  }
  return { version: 1, files: [...new Set(value.files)].sort(), full: value.full,
    deferred: value.deferred, reason: value.reason, ...(value.deferredFiles ? { deferredFiles: [...new Set(value.deferredFiles)].sort() } : {}),
    ...(value.owedFiles?.length ? { owedFiles: [...new Set(value.owedFiles)].sort() } : {}),
    ...(known ? { knownMainFailures: { main: known.main, failures: known.failures.map(({ file, name, signature, item, ran, receipt, firstError, stable, stableData }) => ({ file, name, signature,
      ...failureDetails({ firstError, stable, stableData }, engine), ...(item === undefined ? {} : { item }), ...(ran !== undefined && engine >= KNOWN_MAIN_RUNNING_FILE_ENGINE ? { ran } : {}),
      ...(receipt !== undefined && engine >= KNOWN_MAIN_RECEIPT_ENGINE ? { receipt } : {}) })) } } : {}),
    ...(ambiguous ? { knownMainAmbiguous: ambiguous.map(({ file, name, candidates }) => ({ file, name, candidates: [...candidates] })) } : {}) };
}

