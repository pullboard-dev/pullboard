/** Short-lived opaque pairing envelopes; relay storage never receives or derives the code secret [H15,H17]. */
import { Refused } from '../src/refused.js';

const TEN_MINUTES = 10 * 60_000;
const TOMBSTONE_MINUTES = 10 * 60_000;
const MAX_CODES = 10_000;
const MAX_ENVELOPE_BYTES = 19_000_000;
const MAX_STORED_BYTES = 50_000_000;
const LOCATOR = /^[A-Za-z0-9_-]{22}$/;

/** Validate opaque ciphertext transport without parsing or logging its contents. */
function envelope(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Refused('PAIR_PACKAGE', 'send one encrypted pairing package; create a new code on the linked device');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 28 || bytes.length > MAX_ENVELOPE_BYTES || bytes.toString('base64url') !== value) {
    throw new Refused('PAIR_PACKAGE', 'send one encrypted pairing package; create a new code on the linked device');
  }
  return value;
}

/** Keep codes for ten minutes and retain short-lived tombstones so reuse and expiry are explicit. */
export function createPairingStore({ now = Date.now, ttl = TEN_MINUTES, maxCodes = MAX_CODES, maxBytes = MAX_STORED_BYTES } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttl) || ttl !== TEN_MINUTES ||
      !Number.isSafeInteger(maxCodes) || maxCodes < 1 || maxCodes > MAX_CODES ||
      !Number.isSafeInteger(maxBytes) || maxBytes < MAX_ENVELOPE_BYTES || maxBytes > MAX_STORED_BYTES) {
    throw new Refused('PAIR_CONFIG', 'use the fixed ten-minute code lifetime and a bounded positive pairing capacity');
  }
  const records = new Map();
  let storedBytes = 0;

  /** Drop old tombstones before admitting or consuming more short-lived codes. */
  function prune(at) {
    for (const [locator, record] of records) {
      if (record.status === 'ready' && at >= record.expires) {
        record.status = 'expired';
        storedBytes -= record.bytes;
        record.bytes = 0;
        delete record.sealed;
      }
      if (at >= record.expires + TOMBSTONE_MINUTES) records.delete(locator);
    }
  }

  return Object.freeze({
    /** Store one opaque client-encrypted package under a fresh locator, for ten minutes and one use. */
    publish(board, locator, sealed) {
      const at = now();
      prune(at);
      if (typeof board !== 'string' || !/^[0-9a-f]{32}$/.test(board) || typeof locator !== 'string' || !LOCATOR.test(locator)) throw new Refused('PAIR_CODE_INVALID', 'use a fresh random pairing code for this board');
      const value = envelope(sealed);
      if (records.has(locator)) throw new Refused('PAIR_EXISTS', 'generate a fresh one-time code on the linked device');
      const bytes = Buffer.byteLength(value, 'base64url');
      if (records.size >= maxCodes || storedBytes + bytes > maxBytes) throw new Refused('PAIR_BUSY', 'retry pairing shortly after another code expires');
      records.set(locator, { board, sealed: value, bytes, expires: at + ttl, status: 'ready' });
      storedBytes += bytes;
      return { expiresIn: ttl / 1000 };
    },
    /** Atomically consume an opaque package once; callers authenticate repository access first. */
    consume(board, locator) {
      const at = now();
      prune(at);
      if (typeof board !== 'string' || !/^[0-9a-f]{32}$/.test(board) || typeof locator !== 'string' || !LOCATOR.test(locator)) throw new Refused('PAIR_CODE_INVALID', 'use the full one-time code from the linked device');
      const record = records.get(locator);
      if (!record) throw new Refused('PAIR_CODE_UNKNOWN', 'the one-time code was not found; ask the linked device for a new code');
      if (record.board !== board) throw new Refused('PAIR_CODE_INVALID', 'the one-time code belongs to another board; use the full printed code');
      if (at >= record.expires) {
        record.status = 'expired';
        storedBytes -= record.bytes;
        record.bytes = 0;
        delete record.sealed;
        throw new Refused('PAIR_CODE_EXPIRED', 'the ten-minute pairing code expired; ask the linked device for a new code');
      }
      if (record.status === 'used') throw new Refused('PAIR_CODE_USED', 'the one-time pairing code was already used; ask the linked device for a new code');
      record.status = 'used';
      storedBytes -= record.bytes;
      record.bytes = 0;
      const sealed = record.sealed;
      delete record.sealed;
      return { sealed };
    },
    /** Report only a count for capacity checks and tests; never return board ids or ciphertext. */
    size() { prune(now()); return records.size; },
  });
}
