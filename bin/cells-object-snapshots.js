/** Layer exact changed Git blobs over the accepted inventory without touching a working tree [C7]. */
import { join } from 'node:path';
import {
  gitChildEnv,
  gitExecFileSync,
} from '../packages/git/index.js';
import {
  git,
  cellGitEnvironment,
} from './cells-snapshot-git.js';
import { cellsCacheDirectory } from './cells-inventory-cache.js';

/** Parse immutable tree metadata, retaining symlinks and gitlinks as nonregular entries. */
function entriesAt(root, commit) {
  const listed = git(root, ['ls-tree', '-r', '-z', commit], { maxBuffer: 64 * 1024 ** 2, env: cellGitEnvironment(root) ?? gitChildEnv(root) });
  const entries = new Map();
  for (const row of listed.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/u.exec(row);
    if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid committed cells tree entry');
    entries.set(match[3], { mode: match[1], object: match[2] });
  }
  return entries;
}

/** Hold the baseline bytes in memory and read only candidate paths whose immutable object changed. */
export function cellsObjectSnapshots(root, acceptedMain, commits, artifact, onRead = () => {}) {
  const mainEntries = entriesAt(root, acceptedMain);
  const snapshots = new Map();
  for (const commit of new Set([acceptedMain, ...commits])) {
    const files = new Map(artifact.inventory.files);
    const entries = commit === acceptedMain ? mainEntries : entriesAt(root, commit);
    const changed = commit === acceptedMain ? [] : git(root, ['diff', '--name-only', '--no-renames', '-z', acceptedMain, commit], { env: cellGitEnvironment(root) ?? gitChildEnv(root) }).split('\0').filter(Boolean);
    for (const file of changed) {
      const entry = entries.get(file);
      if (!entry || !/^100(?:644|755)$/u.test(entry.mode)) { files.delete(file); continue; }
      const bytes = gitExecFileSync(['--no-replace-objects', 'cat-file', 'blob', entry.object], {
        cwd: root, env: cellGitEnvironment(root) ?? gitChildEnv(root), encoding: null, maxBuffer: 64 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
      });
      files.set(file, bytes);
      onRead(file, commit);
    }
    const virtualRoot = join(cellsCacheDirectory('snapshots'), commit);
    snapshots.set(commit, { root: virtualRoot, repoRoot: root, commit, files, entries });
  }
  return snapshots;
}
