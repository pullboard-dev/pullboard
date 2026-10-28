import { itemPatchPaths } from './item-patch-paths.js';
import { safeItemPatchPath as safePath } from './item-patch-paths.js';
export { itemPatchPaths } from './item-patch-paths.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from './refused.js';

/** Hash exact bytes, without newline or text normalization. */
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Refuse unsupported composition inputs without executing candidate code. */
function refuse(message) { throw new Refused('ITEM_PATCH', message); }

/** Execute Git plumbing with an isolated index and no optional live-index locks. */
function git(root, env, args, input) {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
      { cwd: root, env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { refuse(`patch composition refused by Git (${args[0]}); resolve the patch against the exact submitted commit`); }
}

/** Validate the native author snapshot, without inventing or resolving session authority. */
function validAuthor(author) {
  return author && typeof author === 'object' && !Array.isArray(author)
    && ['agentId', 'parentSession', 'session'].every(key => author[key] === null
      || typeof author[key] === 'string' && author[key].length > 0 && author[key].length <= 1024 && !/[\x00-\x1f\x7f]/.test(author[key]));
}

/** Canonical ordered patch-set hash shared with native patch-set binding. */
export function itemPatchSetDigest(commit, patches) {
  return sha(JSON.stringify({ commit, patches: patches.map(record => ({ key: record.key, commit: record.commit, digest: record.digest,
    author: { agentId: record.author.agentId, parentSession: record.author.parentSession, session: record.author.session } })) }));
}

/**
 * Compose an ordered, digest-bound patch set using only a private Git index.
 * Records bind commit to the submitted candidate and digest to exact UTF-8 patch bytes.
 * Returns immutable commit, actual changed paths, and ordered-set digest; never runs hooks.
 */
export function composeItemPatches(root, item, patches, { trunk, baseCommit = item?.item_commit } = {}) {
  const base = item?.item_commit;
  if (!/^[a-f0-9]{40,64}$/.test(base ?? '') || !Array.isArray(patches) || patches.length > 256) refuse('invalid submitted commit or patch set');
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  if (git(root, env, ['rev-parse', '--verify', `${base}^{commit}`]).trim() !== base) refuse('submitted commit is not exact');
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit ?? '') || git(root, env, ['rev-parse', '--verify', `${baseCommit}^{commit}`]).trim() !== baseCommit) refuse('composition base must be an exact commit');
  git(root, env, ['merge-base', '--is-ancestor', base, baseCommit]);
  if (trunk) {
    if (!/^[a-f0-9]{40,64}$/.test(trunk)) refuse('trunk must be an exact commit');
    git(root, env, ['merge-base', '--is-ancestor', trunk, baseCommit]);
  }
  const keys = new Set();
  const declared = new Set();
  const records = patches.map(record => {
    if (!record || record.commit !== base || typeof record.patch !== 'string' || Buffer.byteLength(record.patch) > 16 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(record.digest ?? '') || sha(record.patch) !== record.digest
      || typeof record.key !== 'string' || !record.key || record.key.length > 256 || /[\x00-\x1f\x7f]/.test(record.key)
      || !validAuthor(record.author)
      || keys.has(record.key)) refuse('stale, malformed, duplicated or tampered patch record');
    keys.add(record.key);
    for (const path of itemPatchPaths(record.patch)) declared.add(path);
    return { key: record.key, commit: base, digest: record.digest, author: { agentId: record.author.agentId, parentSession: record.author.parentSession, session: record.author.session } };
  });
  const digest = itemPatchSetDigest(base, records);
  if (!patches.length) return Object.freeze({ commit: baseCommit, paths: Object.freeze([]), applied: Object.freeze([]), digest });
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-item-patch-'));
  const isolated = { ...env, GIT_INDEX_FILE: join(directory, 'index') };
  try {
    git(root, isolated, ['read-tree', baseCommit]);
    const applied = [];
    let previous = git(root, isolated, ['write-tree']).trim();
    for (const record of patches) {
      try { git(root, isolated, ['apply', '--cached', '--3way', '--binary', '--whitespace=nowarn', '-'], record.patch); }
      catch { refuse(`companion ${record.key} refused by Git (apply), no longer applies; replace it against the exact source`); }
      const next = git(root, isolated, ['write-tree']).trim();
      const changed = git(root, isolated, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', previous, next]).split('\0').filter(Boolean);
      if (changed.some(path => !safePath(path) || !itemPatchPaths(record.patch).has(path))) refuse('patch changes an undeclared or unsafe path');
      applied.push(Object.freeze({ key: record.key, paths: Object.freeze(changed.sort()) }));
      previous = next;
    }
    const tree = git(root, isolated, ['write-tree']).trim();
    const paths = git(root, isolated, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', baseCommit, tree]).split('\0').filter(Boolean);
    if (!paths.length || paths.some(path => !safePath(path) || !declared.has(path))) refuse('composition has unsupported resulting paths');
    const entries = git(root, isolated, ['ls-tree', '-r', '-z', tree]).split('\0').filter(Boolean);
    for (const entry of entries) {
      const [metadata, path] = entry.split('\t');
      if (paths.includes(path) && !/^100(?:644|755) blob /.test(metadata)) refuse('composition changes a non-regular file');
    }
    const identity = { ...isolated, GIT_AUTHOR_NAME: 'Pullboard patch composer', GIT_AUTHOR_EMAIL: 'patch@pullboard.invalid',
      GIT_COMMITTER_NAME: 'Pullboard patch composer', GIT_COMMITTER_EMAIL: 'patch@pullboard.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2000-01-01T00:00:00+00:00' };
    const commit = git(root, identity, ['commit-tree', tree, '-p', baseCommit], `Compose item patches\n\nSource: ${base}\nBase: ${baseCommit}\nPatch-set: ${digest}\n\nSigned-off-by: ${identity.GIT_AUTHOR_NAME} <${identity.GIT_AUTHOR_EMAIL}>\n`).trim();
    return Object.freeze({ commit, paths: Object.freeze(paths.sort()), applied: Object.freeze(applied), digest });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
