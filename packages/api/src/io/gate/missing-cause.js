/** The failing part for a gate job that printed no receipt, led by what the worker said, for gate.receiptMissingCause [C7,#9925]. */

const LEAD = /^the gate job printed no PULLBOARD_GATE_RECEIPT line \(exit ([^)]*)\): ([\s\S]*)$/u;
const PROOF_NAME = /"[^"\n]*\.js"/gu;
const KEPT_LINES = 20;
const KEPT_BYTES = 2048;
const KEPT_NAMES = 5;
const SECRET = /sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|token|password)['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+_=-]{12,}/iu;

/**
 * The part text for a missing-receipt gate error: its last output lines first, scrubbed and cut to 2 KB, then the proof
 * file list cut to its first 5 names and a count. Null when the error is not the missing-receipt one, so the caller keeps its own text.
 * Why: the worker's own error sat behind a file list of tens of KB, so a red said the receipt was missing and never why.
 *
 * @param {unknown} error - The gate error the runner recorded.
 * @returns {string | null}
 */
export function missingReceiptPart(error) {
  const found = LEAD.exec(String(error ?? ''));
  if (!found) return null;
  const names = [];
  const said = [];
  for (const line of found[2].split(/\r?\n/u)) {
    const listed = line.match(PROOF_NAME) ?? [];
    if (listed.length > 1) { names.push(...listed.map(name => name.slice(1, -1))); continue; }
    if (line.trim()) said.push(SECRET.test(line) ? '[redacted line]' : line.trim().slice(0, 300));
  }
  const output = said.slice(-KEPT_LINES).join(' | ').slice(-KEPT_BYTES);
  const files = names.length ? `; proof files: ${names.slice(0, KEPT_NAMES).join(', ')}${names.length > KEPT_NAMES ? ` (+${names.length - KEPT_NAMES} more)` : ''}` : '';
  return `gate: the gate job printed no PULLBOARD_GATE_RECEIPT line (exit ${found[1]}); worker output ended: ${output || 'nothing'}${files}`;
}
