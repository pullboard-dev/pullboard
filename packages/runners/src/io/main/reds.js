/** Which tested files hold main's own result: read from git, never from the board [C7,#4635]. */

/**
 * The files whose run at `head` is a run of main: all of them when head is on main; when head is main plus an item's
 * commits, only those the item's diff does not touch. Head built on an older main, or unrelated to it, gives none.
 * Why: a green run of item code that edits a file proves nothing about main, and a red one is the item's own fault [C7,#4635].
 * Git comes in as a port, so this cell reads no repository itself.
 *
 * @param {(args: string[]) => { status: number | null, stdout: string }} git - Runs one git read in the checkout.
 * @param {{ main: string, head: string, files: string[] }} at
 * @returns {string[]}
 */
export function filesOfMain(git, { main, head, files }) {
  if (!main || !head) return [];
  if (git(['merge-base', '--is-ancestor', head, main]).status === 0) return [...files];
  const base = git(['merge-base', head, main]);
  if (base.status !== 0 || String(base.stdout).trim() !== main) return [];
  const diff = git(['diff', '--name-only', '-z', main, head]);
  if (diff.status !== 0) return [];
  const names = new Set(String(diff.stdout).split('\0').filter(Boolean));
  return files.filter(file => !names.has(file));
}
