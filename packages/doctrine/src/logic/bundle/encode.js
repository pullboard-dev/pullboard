import { createHash } from 'node:crypto';

/** Canonical JSON text: object keys sorted at every depth, arrays kept in order, no whitespace [C7]. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Encode a rule bundle to canonical bytes and their sha256 digest.
 * Same rules in any key order give the same bytes; each rule carries its origin board and id so identity survives
 * the trip. Pure: no keys, no files, no signatures [C7].
 */
export function encodeBundle({ version, originBoardId, revision, rules }) {
  const body = {
    version, originBoardId, revision,
    rules: rules.map(rule => ({ ...rule, originBoardId: rule.originBoardId ?? originBoardId })),
  };
  const bytes = canonical(body);
  return { bytes, digest: createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

/** Decode canonical bundle bytes back to the bundle they encode, rules in their encoded order [C7]. */
export function decodeBundle(bytes) {
  return JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8'));
}
