export const VERIFICATION_COMPARISON_PREFIX = 'Review comparison: ';
export const NO_SELECTED_COMPARISON_EXECUTION = 'no selected comparison execution';

/** Read a well-formed observation for the current submitted source and frozen bar. */
export function recordedVerificationComparison(thread, item) {
  for (const fact of [...thread].reverse()) {
    if (fact.type !== 'fact' || !fact.text?.startsWith(VERIFICATION_COMPARISON_PREFIX)) continue;
    try {
      const result = JSON.parse(fact.text.slice(VERIFICATION_COMPARISON_PREFIX.length));
      if (result.source === item.item_commit && result.digest === item.item_frozen_digest) return result;
    } catch { /* An ordinary prose fact cannot masquerade as a comparison. */ }
  }
  return null;
}

/** Render only changed red cases and fixed cases, retaining the two execution identities. */
export function renderVerificationComparison(result) {
  if (result.status === 'pending') return `comparison pending for #${result.item}`;
  if (result.status === 'unavailable') return `comparison unavailable: ${result.error}; review on the item's gate receipts`;
  const lines = [`comparison #${result.item}${result.fallback ? ' (main fallback)' : ''}`,
    `head ${result.headCommit}: ${result.head.id ? `run ${result.head.id}` : NO_SELECTED_COMPARISON_EXECUTION}`,
    `base ${result.baseCommit}: ${result.base.id ? `run ${result.base.id}` : NO_SELECTED_COMPARISON_EXECUTION}`];
  if (Array.isArray(result.newRed)) for (const row of result.newRed) lines.push(`new red: ${row.file}: ${row.name}`);
  if (Array.isArray(result.fixed)) for (const row of result.fixed) lines.push(`fixed: ${row.file}: ${row.name}`);
  if (result.newRed === null || result.fixed === null) lines.push('Case comparison incomplete: at least one source has no selected comparison execution.');
  else if (!result.newRed.length && !result.fixed.length) lines.push('No new red or fixed cases.');
  return lines.join('\n');
}
