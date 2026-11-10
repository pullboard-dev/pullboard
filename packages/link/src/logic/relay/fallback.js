/** When a relay failure may let a local board move commit without the relay (#919, #341). */
import { Refused } from '../../../../kernel/light.js';

/**
 * Whether the relay has definitely not accepted this board's first snapshot, so no ordered history exists to protect.
 * Why: an upload whose reply was lost may already be the relay's baseline, so it never counts as unaccepted (#919).
 */
export function baselineNotAccepted(state) {
  return state.mode === 'ordered' && state.baselineAccepted === false && !state.baselineConflict && !state.baselineUncertain;
}

/**
 * Whether a relay failure says nothing definite about the board: a timeout, a lost connection, a busy relay or a 5xx.
 * Why: only a definite refusal (auth, a conflicting baseline) may stop a local move before the relay accepts a baseline.
 */
export function transientRelayFailure(error) {
  if (!(error instanceof Refused)) return false;
  if (['RELAY_UNAVAILABLE', 'RELAY_RESPONSE', 'RELAY_BUSY'].includes(error.code)) return true;
  return Number.isInteger(error.httpStatus) && (error.httpStatus >= 500 || [408, 425, 429].includes(error.httpStatus));
}

/**
 * Name how a relay request failed before any response, from the error's own fields only.
 * Why: a bare "did not answer" hid whether a request timed out, was refused or lost its socket,
 * so load-dependent relay failures could not be attributed (#512).
 */
export function transportFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out';
  const code = error?.cause?.code ?? error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/u.test(code) ? code : 'no connection';
}
