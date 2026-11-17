/**
 * Find secret-looking values in a contribution record [C7,#3912].
 * Why: a record is shared, so a pasted key must be caught before it leaves the machine. Pure: text in, findings out.
 */

/** The kinds of secret the scan names, each with the pattern that finds it. */
const PATTERNS = [
  { kind: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/u },
  { kind: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/u },
  { kind: 'github-token', pattern: /github_pat_[A-Za-z0-9_]{50,}/u },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/**
 * The secret-looking values in a text, one finding per line and kind.
 *
 * @param {string} text - A contribution record.
 * @returns {{ line: number, kind: string }[]} One-based line numbers, in line order; empty for ordinary text.
 */
export function contributionSecrets(text) {
  const found = [];
  String(text ?? '').split('\n').forEach((content, index) => {
    for (const { kind, pattern } of PATTERNS) {
      if (pattern.test(content) && !found.some(finding => finding.line === index + 1 && finding.kind === kind)) found.push({ line: index + 1, kind });
    }
  });
  return found;
}
