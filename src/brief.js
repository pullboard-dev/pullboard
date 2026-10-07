/**
 * A brief's labelled sections (B10, B14): `Files:`, `Change:`, `Test:` and `Out of scope:`, each
 * followed by text on the same line or by lines below it, until the next label. Below the strong
 * route a brief must name its files and its test, because a lighter model works from the brief alone.
 */

const LABEL_RE = /^(files|change|test|out of scope)\s*:\s*(.*)$/i;

/**
 * The brief split into its labelled sections, each a list of non-empty lines without bullets.
 *
 * @param {string} brief
 * @returns {Record<string, string[]>}
 */
export function briefSections(brief) {
  /** @type {Record<string, string[]>} */
  const sections = {};
  let current = '';
  for (const raw of brief.split('\n')) {
    const line = raw.trim();
    const label = LABEL_RE.exec(line);
    if (label) {
      current = label[1].toLowerCase();
      sections[current] = label[2].trim() ? [label[2].trim()] : [];
    } else if (current && line) {
      sections[current].push(line.replace(/^[-*]\s+/, ''));
    }
  }
  return sections;
}

/**
 * The paths a brief's Files section names, without bullets, backticks or trailing notes.
 *
 * @param {string} brief
 * @returns {string[]}
 */
export function briefFiles(brief) {
  return (briefSections(brief).files ?? [])
    .flatMap((entry) => entry.split(/[,\s]+/))
    .map((token) => token.replace(/^[(`'"]+|[)\]'".,;:!?]+$/g, ''))
    .filter((token) => !/^[a-z]+:\/\//i.test(token) && (token.includes('/') || /\.[a-z0-9]+(?:\.[a-z0-9]+)*$/i.test(token)));
}
