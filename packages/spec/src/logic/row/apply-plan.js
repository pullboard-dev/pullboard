/**
 * Decide what the view does after the person decides a spec row: apply it to the spec file and commit it, or say the
 * one command left [C7,#1310]. Pure: the caller reads the checkout, the decision and any stale or held finding, and
 * does the git and file work itself. Pure so the page and the command line give the same answer.
 *
 * @param {{ id: string, decision: 'approve'|'decline', held?: {why?: string, next?: string}|null, stale?: {why?: string, next?: string}|null }} row
 * @param {{ clean: boolean }} checkout whether the checkout has no uncommitted changes
 * @param {{ name: string, email: string }} person who decided, used as the commit author
 * @returns {{ action: 'apply-and-commit', row: string, message: string, author: string }
 *   | { action: 'left', row: string, command: string, why: string }}
 */
export function planViewApproval(row, checkout, person) {
  const left = (finding, why) => ({ action: 'left', row: row.id, command: finding.next || `pullboard spec apply ${row.id}`, why });
  if (row.stale) return left(row.stale, `${row.id}'s decision is stale: ${row.stale.why ?? 'its row changed after the decision'}`);
  if (row.held) return left(row.held, `${row.id}'s decision is held: ${row.held.why ?? 'a hold stops it'}`);
  if (!checkout.clean) {
    return { action: 'left', row: row.id, command: 'pullboard spec apply', why: `the checkout has uncommitted changes, so ${row.id} was not committed` };
  }
  const verb = row.decision === 'approve' ? 'approve' : 'decline';
  return { action: 'apply-and-commit', row: row.id, message: `docs(spec): ${verb} ${row.id}`, author: `${person.name} <${person.email}>` };
}
