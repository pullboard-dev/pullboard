/** Privacy-preserving exclusion guidance shared by the relay shell and device client [H5,H17]. */

/** Name authenticated repositories, or only public machine counts when this browser has no wrap. */
export function excludedNoticeLines(exclusions) {
  return exclusions.flatMap(entry => entry.names
    ? entry.names.map(name => `${name}: excluded from sharing on ${entry.label}. On that computer, run pullboard relay on in this board.`)
    : [`${entry.label}: ${entry.count} board${entry.count === 1 ? '' : 's'} excluded from sharing. On that computer, run pullboard relay on in each excluded board.`]);
}
