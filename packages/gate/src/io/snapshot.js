/** Shape one commit's Git tree as a sealed in-memory source, so reading it needs no checkout or worktree [C7,V4]. */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * The sealed snapshot of a commit from two Git reads the caller makes: every tree entry, and the bytes of each regular
 * file. Symlinks and submodules keep their entry and no bytes, so a reader sees them as non-regular.
 * Why the caller reads: this file imports no other cell, and the Git runner already lives beside the tier selection.
 *
 * @param {string} commit the exact commit id
 * @param {{ tree: string, blobs: (shas: string[]) => Buffer }} reads `tree` is `git ls-tree -r -z --full-tree <commit>`;
 *   `blobs` returns `git cat-file --batch` output for the object ids it is given, in order
 * @returns {{ root: string, entries: Map<string, { mode: string, sha: string }>, files: Map<string, Buffer> } | null} null when a blob is not a blob
 */
export function commitSourceSnapshot(commit, { tree, blobs }) {
  if (!OBJECT.test(commit ?? '')) throw new TypeError('a commit source snapshot needs an exact commit id');
  const entries = new Map(), wanted = new Map();
  for (const row of tree.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, , sha] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    entries.set(path, { mode, sha });
    if (mode === '100644' || mode === '100755') wanted.set(path, sha);
  }
  const shas = [...new Set(wanted.values())];
  const bytes = new Map();
  if (shas.length) {
    const out = blobs(shas);
    let offset = 0;
    for (const sha of shas) {
      const end = out.indexOf(10, offset);
      const [, type, size] = out.subarray(offset, end).toString('utf8').split(' ');
      if (type !== 'blob') return null;
      const start = end + 1, length = Number(size);
      bytes.set(sha, out.subarray(start, start + length));
      offset = start + length + 1;
    }
  }
  const files = new Map([...wanted].map(([path, sha]) => [path, bytes.get(sha)]));
  // A virtual folder that is never created: every read of it is answered from the snapshot, none from a disk.
  return { root: join(realpathSync(tmpdir()), `pullboard-commit-source-${commit}`), entries, files };
}
