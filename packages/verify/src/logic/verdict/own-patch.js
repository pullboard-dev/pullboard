/** Which hunks a submit changed in its own patch, keyed by hunk, so a hunk a rebase only moved is not a change (#9437, #2981) [C7]. */

/**
 * Decode Git's C-style quoted path: backslash escapes and three-digit octal bytes, which together spell UTF-8 names.
 * Why: Git quotes a name with non-ASCII bytes or control characters, and a header read as plain text lost the file, so a changed hunk in it read as unchanged [C7,#2981].
 *
 * @param {string} quoted - A path in double quotes, as Git prints it.
 * @returns {string} the path.
 */
function unquoteGitPath(quoted) {
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  const bytes = [];
  const body = quoted.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') { bytes.push(...Buffer.from(body[index], 'utf8')); continue; }
    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/u.test(octal)) { bytes.push(parseInt(octal, 8)); index += 3; continue; }
    const next = body[index + 1] ?? '\\';
    bytes.push(next in escapes ? escapes[next] : next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The file a `diff --git` header names after the change, plain or quoted by Git.
 *
 * @param {string} line - The header line.
 * @returns {string | null} the path, or null when the header cannot be read.
 */
function diffFile(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/u.exec(rest);
  if (quoted) return unquoteGitPath(quoted[1]).replace(/^b\//u, '');
  const plain = /^a\/(.+?) b\/(.+)$/u.exec(rest);
  return plain ? plain[2] : null;
}

/**
 * Split a unified diff into hunks keyed by file and hunk header.
 * Why the key leaves out the line numbers: a rebase moves a hunk to other lines, and its numbers are the only part of the header that moves.
 * The key is the file, the header's trailing context text, and a count of earlier hunks sharing both, so the same hunk keys the same way in both patches.
 *
 * @param {string} patch - Unified diff text.
 * @returns {{ hunks: Map<string, string>, headers: Map<string, string> }} key -> the hunk's changed lines (context lines left out), and key -> its full header line.
 */
function hunksOf(patch) {
  const hunks = new Map();
  const headers = new Map();
  const seen = new Map();
  let file = null;
  let key = null;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { file = diffFile(line); key = null; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/u.exec(line);
    if (hunk && file !== null) {
      const base = `${file}\u0000${hunk[1]}`;
      const nth = seen.get(base) ?? 0;
      seen.set(base, nth + 1);
      key = `${base}\u0000${nth}`;
      hunks.set(key, '');
      headers.set(key, line);
      continue;
    }
    if (key !== null && /^[+-]/u.test(line)) hunks.set(key, `${hunks.get(key)}${line}\n`);
  }
  return { hunks, headers };
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
  const { hunks: was } = hunksOf(before);
  const { hunks: now } = hunksOf(after);
  const changes = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const [file, header] = key.split('\u0000');
    if (!was.has(key)) changes.push({ file, header, change: 'added' });
    else if (!now.has(key)) changes.push({ file, header, change: 'removed' });
    else if (was.get(key) !== now.get(key)) changes.push({ file, header, change: 'changed' });
  }
  return changes.sort((left, right) => left.file.localeCompare(right.file) || left.header.localeCompare(right.header) || left.change.localeCompare(right.change));
}

/**
 * The full hunk header lines (for example `@@ -20 +20 @@ context`) of the hunks that differ between two versions of a patch, each with its file.
 * Why: a refusal that names only the file leaves the reviewer hunting for the hunk main changed [C7,#2981].
 *
 * @param {string} before - The patch as reviewed.
 * @param {string} after - The patch as it composes now.
 * @returns {{ file: string, header: string }[]} sorted by file, header.
 */
export function changedHunkHeaders(before, after) {
  const was = hunksOf(before);
  const now = hunksOf(after);
  const found = [];
  for (const key of new Set([...was.hunks.keys(), ...now.hunks.keys()])) {
    if (was.hunks.get(key) === now.hunks.get(key)) continue;
    found.push({ file: key.split('\u0000')[0], header: now.headers.get(key) ?? was.headers.get(key) });
  }
  return found.sort((left, right) => left.file.localeCompare(right.file) || left.header.localeCompare(right.header));
}
