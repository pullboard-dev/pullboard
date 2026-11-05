/** Bounded Git proof that a resubmission adds only trunk and actual conflict resolutions [V1,V4]. */
import { createHash } from 'node:crypto';
import { spawnSync } from './windows-child-process.js';
import {
  cleanGitEnvironment,
  mainCheckout,
} from './git.js';

/** Read immutable objects with fixed merge rules, bounded time/output and no external diff drivers. */
function readGit(root, args, statuses, deadline) {
  const remaining = Math.min(5000, deadline - Date.now());
  if (remaining <= 0) throw new Error('merge proof budget exhausted');
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'merge.conflictStyle=merge', '-c', 'merge.renormalize=false',
    '-c', 'core.attributesFile=/dev/null', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', timeout: remaining, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || !statuses.includes(result.status)) throw new Error('merge source unavailable');
  return result.stdout;
}

/** Require every changed old line to lie inside a real, unambiguous generated conflict region. */
function conflictEditsOnly(source, patch, accepted, trunk) {
  const ranges = [];
  let start = null;
  let middle = false;
  for (const [index, line] of source.split('\n').entries()) {
    if (line === `<<<<<<< ${accepted}`) {
      if (start !== null) return false;
      start = index + 1; middle = false;
    } else if (line === '=======') {
      if (start === null || middle) return false;
      middle = true;
    } else if (line === `>>>>>>> ${trunk}`) {
      if (start === null || !middle) return false;
      ranges.push([start, index + 1]); start = null;
    } else if (/^(?:<<<<<<<|>>>>>>>)/u.test(line)) return false;
  }
  if (start !== null || !ranges.length) return false;
  const hunks = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gmu)];
  return hunks.length > 0 && hunks.every(match => {
    const first = Number(match[1]); const count = match[2] === undefined ? 1 : Number(match[2]);
    return ranges.some(([startLine, endLine]) => count === 0
      ? first >= startLine && first < endLine : first >= startLine && first + count - 1 <= endLine);
  });
}

/** Return a replayable source receipt, or null so an uncertain/changed build gets normal review. */
export function captureMergeOnly(root, basis, { commit, tree, trunk, deadline = Date.now() + 10000 }) {
  if (!basis) return null;
  /** Share one total deadline across this bounded set of immutable object reads. */
  const read = (args, statuses = [0]) => readGit(root, args, statuses, deadline);
  try {
    // An external merge driver is mutable executable policy, not a proof from immutable trees.
    if (read(['config', '--get-regexp', '^merge\\..*\\.driver$'], [0, 1]).trim()) return null;
    const parents = read(['show', '-s', '--format=%P', commit]).trim().split(' ');
    if (parents.length !== 2 || parents[0] !== basis.acceptedHead || parents[1] !== trunk) return null;
    if (basis.conflict.trunk) read(['merge-base', '--is-ancestor', basis.conflict.trunk, trunk]);
    const acceptedTree = read(['rev-parse', `${basis.acceptedHead}^{tree}`]).trim();
    if (read(['rev-parse', `${commit}^{tree}`]).trim() !== tree) return null;
    const merged = read(['merge-tree', '--write-tree', '--name-only', '-z', basis.acceptedHead, trunk], [0, 1]).split('\0');
    const mergeTree = merged.shift();
    if (!/^[a-f0-9]{40,64}$/u.test(mergeTree)) return null;
    const conflicts = merged.slice(0, merged.indexOf(''));
    const changed = read(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeTree, tree, '--']).split('\0').filter(Boolean);
    if (changed.length > 32 || conflicts.length > 32 || basis.cleanOnly && (conflicts.length || changed.length)) return null;
    if (conflicts.some(path => !changed.includes(path))) return null;
    for (const path of changed) {
      if (!conflicts.includes(path) || !basis.conflict.files.includes(path)) return null;
      const auto = read(['ls-tree', '-z', mergeTree, '--', path]);
      const actual = read(['ls-tree', '-z', tree, '--', path]);
      if (!/^100(?:644|755) blob /u.test(auto) || auto.slice(0, 6) !== actual.slice(0, 6)) return null;
      const source = read(['show', `${mergeTree}:${path}`]);
      if (source.includes('\0')) return null;
      if (/^(?:<<<<<<<|=======|>>>>>>>)/mu.test(read(['show', `${tree}:${path}`]))) return null;
      const patch = read(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', mergeTree, tree, '--', path]);
      if (!conflictEditsOnly(source, patch, basis.acceptedHead, trunk)) return null;
    }
    const resolutionDiff = read(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', mergeTree, tree, '--']);
    if (resolutionDiff.length > 1024 * 1024) return null;
    const paths = [...new Set([...(basis.review?.paths ?? []), ...read(
      ['diff', '--no-renames', '--name-only', '-z', trunk, commit, '--']).split('\0').filter(Boolean)])].sort();
    return { version: 1, acceptedCommit: basis.acceptedCommit, acceptedHead: basis.acceptedHead,
      acceptedTree, commit, tree, trunk, mergeTree, digest: basis.digest, verdict: basis.verdict,
      reopen: basis.reopen, paths, resolutionDiff,
      resolutionHash: createHash('sha256').update(resolutionDiff).digest('hex') };
  } catch { return null; }
}

/** Derive from this connection's real repository, never a serialized caller's proposed source facts. */
export function deriveMergeOnly(root, basis, { commit, tree, policyCommit }) {
  if (!root || !basis) return null;
  try {
    const branch = mainCheckout(root)?.branch;
    if (!branch?.startsWith('refs/heads/')) return null;
    const trunk = readGit(root, ['rev-parse', '--verify', `${branch}^{commit}`], [0], Date.now() + 5000).trim();
    if (trunk !== policyCommit) return null;
    return captureMergeOnly(root, basis, { commit, tree, trunk });
  } catch { return null; }
}
