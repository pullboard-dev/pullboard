/**
 * An item proves once (RFC 0006 A4, A5): review cites a sealed package's verdict receipt instead of re-checking it,
 * the verdict records the receipts it relied on, and landing runs only the merge composition's journeys and the units
 * no batch item's submit already proved. A package whose hash moved since its seal is re-proved, never cited.
 */
import { requireSealedSkips } from './test/tier/selection.js';

/**
 * The sealed verdicts a review relies on instead of re-running their tests: each skipped package with the receipt
 * its current seal holds. A plan that cites a package the change unseals, or a receipt its seal no longer holds,
 * refuses, so a stale citation re-proves instead of reporting green.
 *
 * @param {string} root
 * @param {{ base?: string | null, commit: string, skipped?: { package: string, hash?: string, receipt?: string | null }[] }} plan
 * @returns {{ package: string, hash: string, receipt: string }[]}
 */
export function reviewCitations(root, plan) {
  if (!plan) return [];
  requireSealedSkips(root, plan);
  return (plan.skipped ?? []).map(row => ({ package: row.package, hash: String(row.hash), receipt: String(row.receipt) }));
}

/**
 * The verdict line that records the receipts a review relied on, or '' when it cited none.
 * @param {{ package: string, hash: string, receipt: string }[]} cited
 */
export function citedReceiptsNote(cited) {
  return cited.length ? `\ncited sealed verdicts: ${cited.map(row => `${row.package}@${row.hash.slice(0, 12)} by receipt ${row.receipt}`).join(', ')}` : '';
}

/**
 * The receipts a recorded verdict note cites, so landing and audits read what a review relied on.
 * @param {string} note
 * @returns {{ package: string, hash: string, receipt: string }[]}
 */
export function citedReceipts(note) {
  const line = /^cited sealed verdicts: (.+)$/mu.exec(String(note ?? ''));
  if (!line) return [];
  return line[1].split(', ').map(entry => /^(\S+)@([0-9a-f]{12}) by receipt (\S+)$/u.exec(entry)).filter(Boolean)
    .map(([, name, hash, receipt]) => ({ package: name, hash, receipt }));
}

/**
 * The files a landing batch runs: every journey of the merge composition and only the units no batch item's exact
 * submit already proved at the same bytes; an item's proof is never repeated.
 * @param {{ units: string[], journeys: string[] }} plan
 * @param {Set<string>} proven units a batch item's submit ran on unchanged test bytes and package content
 * @returns {string[]}
 */
export function landingRunFiles(plan, proven) {
  return [...new Set([...plan.journeys, ...plan.units.filter(file => !proven.has(file))])].sort();
}
