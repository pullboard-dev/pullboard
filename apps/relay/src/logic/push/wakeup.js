/** Sealed push wake-ups: a kind byte plus an opaque sealed blob, never board text [H5,N26]. */
import { Refused } from '../../../../../packages/kernel/index.js';

/** The kinds a person can choose to be woken for; the byte is the kind's place in this list. */
export const WAKEUP_KINDS = Object.freeze(['decisions', 'alerts', 'landings']);

/**
 * Build the wake-up bytes: one kind byte, then the sealed blob untouched.
 * Why: the relay and the push service see only these bytes, so no board text can ride along.
 */
export function buildWakeup(kind, sealedBlob) {
  const code = WAKEUP_KINDS.indexOf(kind);
  if (code < 0) throw new Refused('WAKEUP_KIND', `Use one of ${WAKEUP_KINDS.join(', ')} as the wake-up kind.`);
  if (!(sealedBlob instanceof Uint8Array) || sealedBlob.length === 0) throw new Refused('WAKEUP_BLOB', 'Pass the sealed notice bytes, sealed on the board machine, as the wake-up blob.');
  return Uint8Array.from([code, ...sealedBlob]);
}

/**
 * Client side: split the bytes and open the blob with the device's own opener.
 * Returns the kind and a one-line notice (the first line, trimmed).
 */
export function openWakeup(bytes, open) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw new Refused('WAKEUP_SHAPE', 'Ignore a wake-up without a kind and a sealed blob.');
  const kind = WAKEUP_KINDS[bytes[0]];
  if (!kind) throw new Refused('WAKEUP_KIND', `Use one of ${WAKEUP_KINDS.join(', ')} as the wake-up kind.`);
  const text = String(open(bytes.subarray(1)));
  return { kind, notice: text.split(/\r?\n/u)[0].trim() };
}
