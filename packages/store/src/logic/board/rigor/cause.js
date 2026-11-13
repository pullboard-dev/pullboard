/** The cause key grammar and the readable rigor-auto source line, with no imports: show reads them through the store's pure door [D1,V1,#7505]. */

/** The kinds of cause key and their shapes, in the order help and refusals name them. */
export const CAUSE_FORMS = Object.freeze(['test:<file>::<title>', 'refusal:<CODE>', 'row:<id>', 'doctrine:<id>', 'sentinel:<name>', 'conflict:<file>', 'instruction:<kind>']);

export const CAUSE = /^(?:test:(?<file>[^\s:][^\r\n:]*)::(?<title>\S[^\r\n]*)|refusal:(?<code>[A-Z][A-Z0-9_]*)|row:(?<row>[A-Z][A-Za-z0-9.]*)|doctrine:(?<doctrine>[A-Z][A-Za-z0-9.]*)|sentinel:(?<sentinel>[a-z0-9][a-z0-9._-]{0,63})|conflict:(?<conflict>[^\r\n\0]+)|instruction:(?:assignment|focus|freeze|merge-main|refreeze|routing))$/u;

/** Accept only typed evidence, never prose masquerading as a proof or a decided rule. */
export function readAutomaticRigorSource(source) {
  if (typeof source !== 'string' || !source.startsWith('rigor-auto:')) return null;
  try {
    const value = JSON.parse(decodeURIComponent(source.slice('rigor-auto:'.length)));
    if (value?.version !== 1 || value.unproved !== true || typeof value.key !== 'string' || !CAUSE.test(value.key) || value.key !== value.key.trim()
      || !Array.isArray(value.evidence?.items) || !Number.isSafeInteger(value.evidence.occurrences) || value.evidence.occurrences < 0
      || value.evidence.occurrences === 0 && value.evidence.neverAgain !== true
      || typeof value.evidence.neverAgain !== 'boolean' || !Array.isArray(value.evidence.events) || !value.evidence.events.length
      || value.evidence.events.some(id => !Number.isSafeInteger(id) || id < 1)
      || value.evidence.items.some(item => !Number.isSafeInteger(item?.id) || item.id < 1 || !Array.isArray(item.commits)
        || item.commits.some(commit => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)))) return null;
    return value;
  } catch { return null; /* Malformed historical metadata cannot establish a proposal. */ }
}

/** Read the complete terminal typed source without inferring identity from the surrounding advice. */
export function automaticSourceFromText(text) {
  const source = /(?:^| )Source: (rigor-auto:\S+)$/u.exec(text ?? '')?.[1];
  return readAutomaticRigorSource(source) ? source : null;
}

/** Row text for display: a trailing rigor-auto source becomes one readable line, all other text is unchanged. */
export function readableRigorText(text) {
  const source = automaticSourceFromText(text);
  if (!source) return text;
  const { key, evidence } = readAutomaticRigorSource(source);
  const ids = evidence.items.map(item => `#${item.id}`).join(', ');
  const count = `${evidence.occurrences} occurrence${evidence.occurrences === 1 ? '' : 's'}`;
  return `${text.slice(0, text.length - source.length - ' Source: '.length)} Source: Rigor evidence for ${key}, ${count}${ids ? ` across ${ids}` : ''}.`;
}
