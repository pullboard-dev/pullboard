/** A frozen check naming a test file that main renamed runs the renamed file, found in Git's own rename record [C7,#2969]. */
import { tryGit } from '../../../../git/index.js';

/** The literal test files a check command names, bare or quoted, in order and without repeats. */
function namedTestFiles(check) {
  return [...new Set([...String(check ?? '').matchAll(/(?:^|\s)(['"]?)([\w./-]+\.(?:test\.[cm]?js|spec\.[cm]?js))\1(?=\s|$)/gu)].map(match => match[2]))];
}

/**
 * The renames Git records between two commits, as old path to new path.
 *
 * @param {string} root - Any checkout of the repository.
 * @param {string} base - The commit the check was frozen at.
 * @param {string} commit - The commit the check will run at (main merged in).
 * @returns {Map<string, string>}
 */
export function recordedRenames(root, base, commit) {
  const diff = tryGit(root, ['diff', '--find-renames', '--name-status', '--diff-filter=R', '-z', base, commit]);
  const renames = new Map();
  if (diff.status !== 0) return renames;
  const parts = diff.stdout.split('\0').filter(Boolean);
  for (let at = 0; at + 2 < parts.length && /^R\d*$/u.test(parts[at]); at += 3) renames.set(parts[at + 1], parts[at + 2]);
  return renames;
}

/**
 * Rewrite the test files a check names that the commit lacks but Git records as renamed. A file deleted with no rename is left
 * as written, so it fails or refuses exactly as before. The frozen check itself is never edited; only the command that runs.
 *
 * @param {string} root
 * @param {string} command - The frozen check command.
 * @param {{ base?: string, commit: string }} range - base is the frozen claim head; without it nothing is followed.
 * @returns {{ command: string, followed: Array<{ from: string, to: string }>, missing: string[] }}
 */
export function followRenames(root, command, { base, commit }) {
  const absent = namedTestFiles(command).filter(file => tryGit(root, ['cat-file', '-e', `${commit}:${file}`]).status !== 0);
  if (!absent.length || !base) return { command, followed: [], missing: absent };
  const renames = recordedRenames(root, base, commit);
  const followed = [];
  const missing = [];
  let result = command;
  for (const file of absent) {
    // A rename chain (a to b to c) ends at the file the commit holds.
    let target = renames.get(file);
    for (let hops = 0; target && renames.has(target) && hops < 20; hops += 1) target = renames.get(target);
    if (!target || tryGit(root, ['cat-file', '-e', `${commit}:${target}`]).status !== 0) { missing.push(file); continue; }
    followed.push({ from: file, to: target });
    result = result.replace(new RegExp(`(^|\\s)(['"]?)${file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\2(?=\\s|$)`, 'gu'), (_all, lead, quote) => `${lead}${quote}${target}${quote}`);
  }
  return { command: result, followed, missing };
}
