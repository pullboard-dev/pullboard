/** The thread lines `pullboard show` prints last, kept pure so a thin door can print them without the heavy readers [C7]. */

/**
 * The thread header and one line per entry, exactly as show printed them: a fact with its ref line, any other entry
 * with its commit, title change, reason and note. Proof-run entries are skipped. Why plain values in: the caller owns
 * the agent names and the first-line cut, so this module reads no config or board.
 *
 * @param {any[]} thread the item's thread entries, oldest first
 * @param {(by: string) => string} nameOf the display name for an entry's author
 * @param {(note: string) => string} [firstLineOf] the cut applied to an escalate note, the one note shown short
 * @returns {string[]}
 */
export function threadLines(thread, nameOf, firstLineOf = note => note) {
  const lines = ['thread:'];
  for (const entry of thread) {
    if (entry.kind === 'proof-run') continue;
    const stamp = `  ${entry.at}  ${nameOf(entry.by)}  `;
    if (entry.type === 'fact') {
      lines.push(`${stamp}fact ${entry.kind} ${entry.id}${entry.answers ? ' (answers ' + entry.answers + ')' : entry.supersedes ? ' (supersedes ' + entry.supersedes + ')' : ''}: ${entry.text}`);
      if (entry.ref) lines.push(`    ref: ${entry.ref.path}:${entry.ref.start}${entry.ref.end === entry.ref.start ? '' : '-' + entry.ref.end}@${entry.ref.commit}`);
    } else {
      const detail = entry.detail;
      lines.push(`${stamp}${entry.kind}${detail.commit ? ' at ' + detail.commit : ''}${detail.previousTitle ? ` (title was: ${detail.previousTitle})` : ''}${detail.reason ? ': ' + detail.reason : ''}${detail.note ? `: ${entry.kind === 'escalate' ? firstLineOf(detail.note) : detail.note}` : ''}`);
    }
  }
  return lines;
}
