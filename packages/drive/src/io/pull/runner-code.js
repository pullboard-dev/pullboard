/**
 * The runnerCode port a pull serve is handed: it answers whether a trunk commit's service code differs from the code
 * installed on this runner, and rebuilds that code from it [P7]. The serve asks once per new commit the board reports
 * (a claim answer's runnerCommit, #10819), so a runner never rebuilds twice for one commit and a failed rebuild is
 * said once, not at every claim. This module owns that bookkeeping; the port itself is the runners cell's (#10824).
 *
 * @param {{ changed: (commit: string) => Promise<boolean>, refresh: (commit: string) => Promise<unknown> } | null} port
 * @param {(line: string) => void} say
 */
export function runnerCodeWatch(port, say) {
  let seen = null;
  const short = commit => String(commit).slice(0, 12);
  return {
    /** The commit to refresh to when the board reports one this runner has not asked about and its code differs; else null. */
    async due(commit) {
      if (!port || typeof commit !== 'string' || !commit || commit === seen) return null;
      seen = commit;
      try { return await port.changed(commit) ? commit : null; } catch (error) {
        say(`could not compare runner code with ${short(commit)}: ${error?.message ?? error}; keeping the current code`);
        return null;
      }
    },
    /** Rebuild the runner code from a commit: true when it is in place and the serve should restart, false (said once) when it failed. */
    async apply(commit) {
      try { await port.refresh(commit); } catch (error) {
        say(`runner code update to ${short(commit)} failed: ${error?.message ?? error}; keeping the current code`);
        return false;
      }
      say(`runner code updated to ${short(commit)}; restart the serve to run it`);
      return true;
    },
  };
}
