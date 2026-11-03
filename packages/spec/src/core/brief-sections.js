/** A brief's labelled sections, pure so item cores can read them without the spec shell [B10,B14,C7]. */

const LABEL_RE = /^(files|change|test|out of scope)\s*:\s*(.*)$/i;
const REFERENCE_LABEL_RE = /^(files|change|test|out of scope|reference)\s*:\s*(.*)$/i;

/**
 * The brief split into its labelled sections, each a list of non-empty lines without bullets.
 *
 * @param {string} brief
 * @param {{ references?: boolean }} [options] Preserve the old section grammar during historical replay.
 * @returns {Record<string, string[]>}
 */
export function briefSections(brief, { references = true } = {}) {
  /** @type {Record<string, string[]>} */
  const sections = {};
  let current = '';
  for (const raw of brief.split('\n')) {
    const line = raw.trim();
    const label = (references ? REFERENCE_LABEL_RE : LABEL_RE).exec(line);
    if (label) {
      current = label[1].toLowerCase();
      if (current === 'reference') {
        sections.reference ??= [];
        if (label[2].trim()) sections.reference.push(label[2].trim());
        current = ''; // Only explicit Reference: lines can opt private text into acknowledgement.
      } else sections[current] = label[2].trim() ? [label[2].trim()] : [];
    } else if (current && line) {
      sections[current].push(line.replace(/^[-*]\s+/, ''));
    }
  }
  return sections;
}
