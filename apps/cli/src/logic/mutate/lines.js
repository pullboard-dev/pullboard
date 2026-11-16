/** Which lines a change touched, read from `git diff -U0` text, so a mutation check seeds faults only where code changed [C7]. */

/**
 * New-side line numbers changed per file. A pure deletion adds no line, and an empty diff gives no files.
 *
 * @param {string} diffText output of `git diff -U0`
 * @returns {Record<string, number[]>} file path to ascending line numbers
 */
export function changedLines(diffText) {
  const files = {};
  let file = null;
  for (const row of String(diffText ?? '').split('\n')) {
    if (row.startsWith('+++ ')) {
      file = row === '+++ /dev/null' ? null : row.replace(/^\+\+\+ (?:b\/)?/, '');
      continue;
    }
    const hunk = file === null ? null : /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = files[file] ?? (files[file] = []);
    for (let at = start; at < start + count; at++) lines.push(at);
  }
  return files;
}
