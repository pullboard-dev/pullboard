import { itemPatchPaths } from "../../logic/paths.js";
import { safeItemPatchPath as safePath } from "../../logic/paths.js";
export { itemPatchPaths } from "../../logic/paths.js";
import { createHash } from 'node:crypto';
import { gitExecFileSync } from "../../../../git/index.js";
import { gitSpawnSync } from "../../../../git/index.js";
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from "../../../../kernel/index.js";

/** Hash exact bytes, without newline or text normalization. */
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Refuse unsupported composition inputs without executing candidate code. */
function refuse(message) { throw new Refused('ITEM_PATCH', message); }

/** Execute Git plumbing with an isolated index and no optional live-index locks. */
function git(root, env, args, input, patch) {
  try {
    return gitExecFileSync(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
      { cwd: root, env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    if (patch) refuse(patchFailure(patch, String(error.stderr ?? '')));
    refuse(`patch composition refused by Git (${args[0]}); resolve the patch against the exact submitted commit`);
  }
}

/** Report only validated file names and numeric hunk headers, never failed source lines or Git output. */
function patchFailure(record, stderr) {
  const paths = [...itemPatchPaths(record.patch)];
  const failed = stderr.split('\n').map(line => /^error: patch failed: (.+):(\d+)$/u.exec(line)).find(match => match && paths.includes(match[1]));
  const path = failed?.[1] ?? paths.find(path => stderr.includes(path)) ?? paths[0];
  let file;
  const hunks = [];
  for (const line of record.patch.split('\n')) {
    if (line.startsWith('diff --git ')) file = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line)?.[2];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (file === path && hunk) hunks.push(hunk);
  }
  const line = Number(failed?.[2]);
  const exact = hunks.find(hunk => line >= Number(hunk[1]) && line < Number(hunk[1]) + Math.max(1, Number(hunk[2] ?? 1)));
  const headers = (exact ? [exact] : hunks).map(hunk => hunk[0]).join(', ') || 'binary or file-mode operation';
  return `companion ${record.key} no longer applies: file ${path}; hunk ${headers}; replace it against the current builder head`;
}

/** One index entry as { mode, oid }, or null when the path is absent. */
function entryAt(root, env, spec, path) {
  const listed = spec === ':index' ? git(root, env, ['ls-files', '-s', '-z', '--', path]) : git(root, env, ['ls-tree', '-z', spec, '--', path]);
  const row = listed.split('\0').find(Boolean);
  if (!row) return null;
  const fields = row.split('\t')[0].split(' ');
  return spec === ':index' ? { mode: fields[0], oid: fields[1] } : { mode: fields[0], oid: fields[2] };
}

/** The patch's hunk headers for one file whose old ranges meet the lines the head changed since the origin. */
function overlappingHunks(record, path, changed) {
  let file;
  const hunks = [];
  for (const line of record.patch.split('\n')) {
    if (line.startsWith('diff --git ')) file = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line)?.[2];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
    if (file === path && hunk) hunks.push({ header: hunk[0], start: Number(hunk[1]), end: Number(hunk[1]) + Math.max(1, Number(hunk[2] ?? 1)) });
  }
  const hit = hunks.filter(hunk => changed.some(([start, end]) => start < hunk.end && hunk.start < end));
  return (hit.length ? hit : hunks).map(hunk => hunk.header).join(', ');
}

/**
 * Apply one companion by a per-file three-way merge: the patch applied to its origin is "theirs", the composition
 * so far is "ours", and the origin is the base. A path both sides changed in overlapping lines refuses, naming the
 * file and the companion hunk; every other change merges with no coordinator step (#2625).
 */
function mergeFromOrigin(root, isolated, record, origin, directory) {
  const scratch = { ...isolated, GIT_INDEX_FILE: join(directory, 'origin-index') };
  git(root, scratch, ['read-tree', origin]);
  git(root, scratch, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], record.patch, record);
  for (const path of itemPatchPaths(record.patch)) {
    const base = entryAt(root, scratch, origin, path), theirs = entryAt(root, scratch, ':index', path), ours = entryAt(root, isolated, ':index', path);
    if (base?.oid === theirs?.oid && base?.mode === theirs?.mode) continue;
    if (ours?.oid === theirs?.oid && ours?.mode === theirs?.mode) continue;
    if (ours?.oid === base?.oid && ours?.mode === base?.mode) {
      if (theirs) git(root, isolated, ['update-index', '--add', '--cacheinfo', `${theirs.mode},${theirs.oid},${path}`]);
      else git(root, isolated, ['update-index', '--force-remove', '--', path]);
      continue;
    }
    const hunk = overlappingHunks(record, path, []) || 'binary or file-mode operation';
    if (!base || !theirs || !ours) refuse(`companion ${record.key} conflicts with the head: file ${path}; hunk ${hunk}; added or deleted on both sides; replace it against the current builder head`);
    const mode = ours.mode === theirs.mode || theirs.mode === base.mode ? ours.mode : ours.mode === base.mode ? theirs.mode : null;
    if (!mode) refuse(`companion ${record.key} conflicts with the head: file ${path}; hunk ${hunk}; incompatible file modes; replace it against the current builder head`);
    const files = ['ours', 'base', 'theirs'].map(name => join(directory, `merge-${name}`));
    [ours, base, theirs].forEach((entry, index) => writeFileSync(files[index], git(root, isolated, ['cat-file', 'blob', entry.oid])));
    const merged = gitSpawnSync(['merge-file', '-p', ...files], { cwd: root, env: isolated, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (merged.status !== 0) {
      const diff = git(root, isolated, ['diff', '-U0', '--no-color', base.oid, ours.oid]);
      const changed = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? /gmu)].map(match => [Number(match[1]), Number(match[1]) + Math.max(1, Number(match[2] ?? 1))]);
      refuse(`companion ${record.key} conflicts with the head: file ${path}; hunk ${overlappingHunks(record, path, changed)}; replace it against the current builder head`);
    }
    const oid = git(root, isolated, ['hash-object', '-w', '--stdin'], merged.stdout).trim();
    git(root, isolated, ['update-index', '--cacheinfo', `${mode},${oid},${path}`]);
  }
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
      // A companion is written against the head it was attached to; when that head or main moved under it, a
      // per-file three-way merge from its origin keeps it applying, and only a true overlap refuses (#2625).
      const origin = [record.attachedCommit, record.origin].find(commit => /^[a-f0-9]{40,64}$/.test(commit ?? '') && commit !== baseCommit);
      const direct = gitSpawnSync(['-c', 'core.hooksPath=/dev/null', 'apply', '--cached', '--3way', '--binary', '--whitespace=nowarn', '-'],
        { cwd: root, env: isolated, input: record.patch, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (direct.status !== 0) {
        if (!origin) refuse(patchFailure(record, String(direct.stderr ?? '')));
        git(root, isolated, ['read-tree', previous]);
        mergeFromOrigin(root, isolated, record, origin, directory);
      }
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
