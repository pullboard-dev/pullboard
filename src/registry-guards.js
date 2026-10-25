/** Accepted project registry obligations survive import-selection deferral [C7,V4,V16]. */
import { git } from './git.js';

/** A literal repository path, or an input glob using only *, ** and ?. */
function projectPath(value, glob = false) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && !/[:\\\p{Cc}]/u.test(value) && !/[\[\]{}]/u.test(value)
    && (glob || !/[*?]/u.test(value))
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Reject ambiguous configuration rather than silently dropping a registry obligation. */
export function registryGuardsProblem(rules) {
  if (!Array.isArray(rules) || rules.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule)
    || Object.keys(rule).some(key => !['inputs', 'tests'].includes(key))
    || !Array.isArray(rule.inputs) || !rule.inputs.length || rule.inputs.some(path => !projectPath(path, true))
    || !Array.isArray(rule.tests) || !rule.tests.length || rule.tests.some(path => !projectPath(path)))) {
    return '"registryGuards" is a list of {inputs: [repository globs using *, ** or ?], tests: [literal repository test paths]}';
  }
  return null;
}

/** Match the entire repository-relative path, allowing recursive globs to cover no directories. */
function matches(path, glob) {
  const source = glob.split(/(\*\*\/|\*\*|\*|\?)/u).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
    : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^$()|[\]{}\\]/gu, '\\$&')).join('');
  return new RegExp(`^${source}$`, 'u').test(path);
}

/** Select from the same merge base as affected tests, retaining deletions and both sides of renames. */
export function selectRegistryGuards(root, rules = [], { base, trunk, commit = 'HEAD', changed } = {}) {
  if (!rules.length) return [];
  if (trunk) {
    const mergeBase = git(root, ['merge-base', trunk, commit]).trim();
    const submitted = git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
    if (mergeBase !== submitted) base = mergeBase;
    changed = undefined;
  }
  // No base is uncertainty, never evidence that none of the registries changed.
  if (base) changed ??= git(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean);
  return [...new Set(rules.filter(rule => !base || changed.some(path => rule.inputs.some(glob => matches(path, glob))))
    .flatMap(rule => rule.tests))].sort();
}
