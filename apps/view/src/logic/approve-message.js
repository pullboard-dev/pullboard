/** What the view says after an approval: committed, the one command left, or still pending apply [N26]. */

/**
 * The sentence for an approved spec row. Self-contained, because the page script embeds this function's source.
 *
 * @param {string} ids - The approved row ids.
 * @param {{commit?: string|null, command?: string|null}|null} [result] - What applying the approval did, when it did anything.
 * @returns {string} Committed with the short id, the command still to run, or pending apply when the result names neither.
 */
export function approveMessage(ids, result = null) {
  const commit = typeof result?.commit === 'string' && result.commit ? result.commit.slice(0, 7) : null;
  const command = typeof result?.command === 'string' && result.command ? result.command : null;
  if (commit) return 'approved rows ' + ids + ' and committed ' + commit;
  if (command) return 'approved rows ' + ids + '; run ' + command;
  return 'approved rows ' + ids + ' (pending apply)';
}
