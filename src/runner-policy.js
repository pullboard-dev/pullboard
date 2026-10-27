/** Source-bound coordinator policy delivered by a runner, without a board or environment override [C7,V4]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { gitPath } from './git.js';
import { cleanGitEnvironment } from './git.js';
import { tryGit } from './git.js';
import { repoInfo } from './git.js';
import { Refused } from './refused.js';

export const RUNNER_POLICY_FILE = 'pullboard-runner-policy.json';
const OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Validate a carried branch identity without accepting a guessed candidate ancestor. */
export function validRunnerTrunk(trunk, commit) {
  return Boolean(trunk && Object.keys(trunk).sort().join(',') === 'commit,ref'
    && typeof trunk.ref === 'string' && /^refs\/heads\/[\w./-]+$/u.test(trunk.ref)
    && !trunk.ref.includes('..') && !trunk.ref.endsWith('/')
    && OBJECT.test(trunk.commit ?? '') && trunk.commit.length === commit.length);
}

/** Bind the admitted policy to this exact worker job and candidate source. */
export function runnerPolicyRecord(spec) {
  if (!validRunnerTrunk(spec.trunk, spec.commit) || !OBJECT.test(spec.commit ?? '')
    || !OBJECT.test(spec.tree ?? '') || spec.tree.length !== spec.commit.length
    || !/^[A-Za-z0-9_-]{1,100}$/u.test(spec.id ?? '')) throw new Error('invalid runner policy context');
  const context = { version: 1, job: spec.id, commit: spec.commit, tree: spec.tree,
    trunk: { ref: spec.trunk.ref, commit: spec.trunk.commit } };
  return { ...context, sha256: createHash('sha256').update(JSON.stringify(context)).digest('hex') };
}

/** Read only an exact worker-installed context; missing provenance stays unavailable. */
export function carriedRunnerTrunk(root) {
  if (!repoInfo(root).isMain) return null;
  const file = gitPath(root, RUNNER_POLICY_FILE);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    const expected = runnerPolicyRecord({ id: record.job, commit: record.commit, tree: record.tree, trunk: record.trunk });
    if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error('changed admission context');
    for (const [ref, expectedObject] of [['HEAD^{commit}', record.commit], ['HEAD^{tree}', record.tree],
      [`${record.trunk.ref}^{commit}`, record.trunk.commit]]) {
      const actual = tryGit(root, ['rev-parse', '--verify', ref], { env: cleanGitEnvironment() });
      if (actual.status !== 0 || actual.stdout.trim() !== expectedObject) throw new Error('changed admission source or policy');
    }
    return record.trunk;
  } catch {
    throw new Refused('NO_POLICY', 'the runner admission policy is missing, malformed or does not match this source; rerun through the controller with its pinned coordinator policy');
  }
}
