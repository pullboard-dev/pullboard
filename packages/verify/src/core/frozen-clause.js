/** Normalize presentation whitespace without changing the quoted requirement's wording. */
export function wording(value) { return String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' '); }

/** Extract semantic bar content, excluding a policy commit that can change during ordinary rebases. */
export function frozenBar(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen); }
  catch { return { criterion: wording(item.item_frozen), rows: [], check: '' }; }
  if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) {
    return { criterion: wording(item.item_frozen), rows: [], check: '' };
  }
  return { criterion: wording(frozen.criterion), check: wording(frozen.check),
    rows: Array.isArray(frozen.rows) ? frozen.rows.map(row => ({ id: row.id, text: wording(row.text) })) : [] };
}

/** Resolve an unambiguous quotation to its containing requirement, so shorter quotes cannot reset a round. */
export function namedClause(bar, quote, includeCheck = false) {
  const texts = [...new Set([bar.criterion, ...(includeCheck ? [bar.check] : []), ...bar.rows.map(row => row.text)]
    .flatMap(text => [text, ...text.split(/(?<=[.!?])\s+/u)])
    .filter(text => text && text.includes(quote)))];
  const clauses = texts.filter(text => !texts.some(other => other !== text && text.includes(other)));
  return clauses.length === 1 ? clauses[0] : null;
}

