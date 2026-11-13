/** File identity from the git index, so fingerprinting the tool's own source does not re-read every file [C7]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { git } from '../main.js';

const BUFFER = 256 * 1024 * 1024;

/** The git blob id of these bytes: what `git hash-object` prints, so a dirty file and its committed twin agree. */
export function blobOid(bytes, length = 40) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash(length === 64 ? 'sha256' : 'sha1').update(header).update(bytes).digest('hex');
}

/** Split a NUL-terminated git listing. */
function records(text) {
  return text.split('\0').filter(Boolean);
}

/**
 * Regular files that git tracks and has not seen change, keyed by path relative to `root`, with mode and blob id;
 * `dirty` names tracked files that changed or are missing, `untracked` the files git would add. Null when `root` is not
 * a git checkout or git cannot answer, and the caller then reads files itself.
 *
 * @param {string} root checkout root
 * @param {string[]} [paths] limit the answer to these folders or files
 * @returns {{ clean: Map<string, { mode: string, oid: string }>, dirty: Set<string>, untracked: Set<string>, links: Set<string>, length: number } | null}
 */
export function indexedFiles(root, paths = []) {
  if (!existsSync(`${root}/.git`)) return null;
  const spec = paths.length ? ['--', ...paths] : [];
  try {
    const staged = records(git(root, ['ls-files', '-s', '-z', ...spec], { maxBuffer: BUFFER }));
    const changed = records(git(root, ['ls-files', '-m', '-o', '--exclude-standard', '-z', ...spec], { maxBuffer: BUFFER }));
    const modified = new Set(changed);
    const clean = new Map();
    const tracked = new Set();
    const links = new Set();
    let length = 40;
    for (const line of staged) {
      const tab = line.indexOf('\t');
      const [mode, oid, stage] = line.slice(0, tab).split(' ');
      const path = line.slice(tab + 1);
      tracked.add(path);
      length = oid.length;
      if (mode === '120000') links.add(path);
      else if (stage === '0' && (mode === '100644' || mode === '100755') && !modified.has(path)) clean.set(path, { mode, oid });
    }
    const dirty = new Set();
    const untracked = new Set();
    for (const path of modified) (tracked.has(path) ? dirty : untracked).add(path);
    return { clean, dirty, untracked, links, length };
  } catch { return null; }
}
