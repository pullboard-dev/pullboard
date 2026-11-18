/** Which hunks a submit changed in its own patch, keyed by hunk, so a hunk a rebase only moved is not a change (#9437, #2981) [C7]. */

/**
 * Split a unified diff into hunks keyed by file and hunk header.
 * Why the key leaves out the line numbers: a rebase moves a hunk to other lines, and its numbers are the only part of the header that moves.
 * The key is the file, the header's trailing context text, and a count of earlier hunks sharing both, so the same hunk keys the same way in both patches.
 *
 * @param {string} patch - Unified diff text.
 * @returns {Map<string, string>} key -> the hunk's changed lines (context lines left out).
 */
function hunksOf(patch) {
  const hunks = new Map();
  const seen = new Map();
  let file = null;
  let key = null;
  for (const line of String(patch ?? '').split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (header) { file = header[2]; key = null; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/u.exec(line);
    if (hunk && file !== null) {
      const base = `${file}\u0000${hunk[1]}`;
      const nth = seen.get(base) ?? 0;
      seen.set(base, nth + 1);
      key = `${base}\u0000${nth}`;
      hunks.set(key, '');
      continue;
    }
    if (key !== null && /^[+-]/u.test(line)) hunks.set(key, `${hunks.get(key)}${line}\n`);
  }
  return hunks;
}

/**
 * The hunks that differ between two versions of a submit's own patch, keyed by file and hunk header.
 * A hunk with the same changed lines in both is left out even when a rebase moved it to other line numbers.
 * Why: a change main made elsewhere in a shared file says nothing about the reviewed hunks, so only a differing hunk makes the review stale.
 *
 * @param {string} before - The patch as reviewed.
 * @param {string} after - The patch as it composes now.
 * @returns {{ file: string, header: string, change: 'changed' | 'added' | 'removed' }[]} sorted by file, header, change.
 */
export function ownPatchChanges(before, after) {
  const was = hunksOf(before);
  const now = hunksOf(after);
  const changes = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const [file, header] = key.split('\u0000');
    if (!was.has(key)) changes.push({ file, header, change: 'added' });
    else if (!now.has(key)) changes.push({ file, header, change: 'removed' });
    else if (was.get(key) !== now.get(key)) changes.push({ file, header, change: 'changed' });
  }
  return changes.sort((left, right) => left.file.localeCompare(right.file) || left.header.localeCompare(right.header) || left.change.localeCompare(right.change));
}
