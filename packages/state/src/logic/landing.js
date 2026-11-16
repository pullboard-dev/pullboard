/** Pure manual-note engine classifier shared by replay preparation [H16,C7]. */
/** Whether a manual landing note quotes a semicolon-delimited test name, including malformed attempts. */
export function manualLandingFailureQuoted(note) {
  if (typeof note !== 'string') return false;
  const generatedPrefix = /^Landing batch [a-z0-9_-]{1,80} failed /iu.exec(note);
  if (generatedPrefix) return false;
  const opening = /(?:^|;[ \t]*)(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]+:[ \t]*"/giu;
  for (const match of note.matchAll(opening)) {
    let escaped = false;
    let containsSeparator = false;
    for (let index = match.index + match[0].length; index < note.length; index += 1) {
      const character = note[index];
      if (character === ';') containsSeparator = true;
      if (character === '\r' || character === '\n') break;
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') break;
    }
    if (containsSeparator) return true;
  }
  return false;
}

/** Recognize new landing receipt relationships without interpreting malformed batch input. */
export function carriesFlakeDiagnostics(batch) {
  return Boolean(batch && (Object.hasOwn(batch, 'flakeDiagnostics')
    || Array.isArray(batch.gateResults) && batch.gateResults.some(result => result && Object.hasOwn(result, 'flakeDiagnostics'))));
}
