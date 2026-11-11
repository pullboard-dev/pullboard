/** Optional verifier annotations are evidence, never a person's approval [S1,V4]. */

/** Parse the declared seat separately from its required following reason segment. */
export function parseRowVerification(value, reason) {
  const match = /^(accepted|rejected) by ([^\s|]+)$/u.exec(value);
  return match ? { decision: match[1], by: match[2], reason } : { invalid: value, reason };
}

/** Keep absent annotations byte-compatible and report malformed or empty verdicts explicitly. */
export function rowVerificationFormatProblems(verification) {
  if (verification === undefined) return [];
  return !verification || !['accepted', 'rejected'].includes(verification.decision)
    || typeof verification.by !== 'string' || !/^[^\s|]+$/u.test(verification.by)
    || typeof verification.reason !== 'string' || !verification.reason.trim() || /[\r\n|]/u.test(verification.reason)
    ? ['verify needs accepted or rejected by <seat>, followed by | <one-line reason>'] : [];
}

/** Remove only a terminal verifier annotation; all normative source bytes stay bound. */
export function rowVerificationSource(source) {
  return source.replace(/ \| verify: (?:accepted|rejected) by [^\s|]+ \| [^\r\n|]+$/u, '');
}

/** Materialize the exact recorded source with its actual verifier and reason. */
export function verifiedRowSource(record) {
  return `${record.source} | verify: ${record.decision} by ${record.by} | ${record.reason}`;
}
