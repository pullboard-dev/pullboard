/** Measure and format sealed snapshot size refusals without transport or link state [H5,H17]. */
import {
  SEALED_SNAPSHOT_BYTES as SEALED_SNAPSHOT_LIMIT,
  SNAPSHOT_BODY_BYTES,
} from './limits.js';

/** Measure a pending sealed snapshot against the relay's decoded journal limit. */
export function snapshotSize(state) {
  if (state?.snapshotApiVersion === 2) return null;
  const sealed = state?.snapshot?.sealed ?? state?.checkpoint?.sealed;
  if (typeof sealed !== 'string') return null;
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.toString('base64url') !== sealed || bytes.byteLength <= SEALED_SNAPSHOT_LIMIT) return null;
  return { board: state.board, sealedBytes: bytes.byteLength, limit: SEALED_SNAPSHOT_LIMIT };
}

/** Accept a structured relay limit only when its measurement matches the exact refused request or ciphertext. */
export function reportedSnapshotSize(error, state) {
  const value = error.snapshotLimit;
  if (!value || Object.keys(value).sort().join(',') !== 'limit,sealedBytes'
      || !Number.isSafeInteger(value.sealedBytes) || !Number.isSafeInteger(value.limit)
      || value.limit < 1 || value.sealedBytes <= value.limit
      || ![400, 413].includes(error.httpStatus) || typeof state.snapshot?.sealed !== 'string') return null;
  const bytes = Buffer.from(state.snapshot.sealed, 'base64url');
  if (bytes.toString('base64url') !== state.snapshot.sealed) return null;
  // An over-limit request body is refused before parsing, so the relay measured the JSON body, not the ciphertext (#1196).
  // Accept it only when that count matches the body this client sent, and report the ciphertext size it knows.
  if (value.limit === SNAPSHOT_BODY_BYTES) {
    if (Buffer.byteLength(JSON.stringify(state.snapshot)) !== value.sealedBytes || bytes.byteLength <= SEALED_SNAPSHOT_LIMIT) return null;
    return { sealedBytes: bytes.byteLength, limit: SEALED_SNAPSHOT_LIMIT };
  }
  if (value.limit > SEALED_SNAPSHOT_LIMIT || bytes.byteLength !== value.sealedBytes) return null;
  return { sealedBytes: bytes.byteLength, limit: value.limit };
}

/** Format a shared status line for an oversized sealed snapshot. */
export function formatSnapshotLimit(problem, { paused = false } = {}) {
  const size = `${(problem.sealedBytes / 1_000_000).toFixed(1)} MB`;
  const limit = `${(problem.limit / 1_000_000).toFixed(1)} MB`;
  if (paused) return `relay paused for ${problem.board}: snapshot ${size} over the relay limit ${limit}; it resumes when the relay supports bounded snapshots`;
  return `relay snapshot for ${problem.board}: sealed snapshot ${size} over the relay limit ${limit}`;
}

