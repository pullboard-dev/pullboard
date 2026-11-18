/** What the view says after an approval: committed, the one command left, or still pending apply [N26]. */

/**
 * The sentence for an approved spec row. Self-contained, because the page script embeds this function's source.
 *
 * @param {string} ids - The approved row ids.
 * @param {{applied?: {commit?: string|null, left?: string|null}, commit?: string|null, command?: string|null}|null} [result] - The move result: its `applied` field, or the older flat commit and command.
 * @returns {string} Committed with the short id, the command still to run, or pending apply when the result names neither.
 */
export function approveMessage(ids, result = null) {
  const applied = result?.applied ?? result;
  const commit = typeof applied?.commit === 'string' && applied.commit ? applied.commit.slice(0, 7) : null;
  const command = [applied?.left, applied?.command].find((text) => typeof text === 'string' && text);
  if (commit) return 'approved rows ' + ids + ' and committed ' + commit;
  if (command) return 'approved rows ' + ids + (applied?.left ? '; one command left: ' : '; run ') + command;
  return 'approved rows ' + ids + ' (pending apply)';
}
