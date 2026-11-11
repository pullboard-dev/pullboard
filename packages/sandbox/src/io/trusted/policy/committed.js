/** Read committed coordinator policy without loading check execution or resource admission [C7,V4]. */
import {
  spawnSync,
} from 'node:child_process';
import {
  createHash,
} from 'node:crypto';
import {
  existsSync,
} from 'node:fs';
import {
  readFileSync,
} from 'node:fs';
import {
  configFromSource,
} from '../../../../../config/light.js';
import {
  cleanGitEnvironment,
  mainCheckout,
  gitPath,
  pinnedWorkingText,
  tryGit,
  repoInfo,
} from '../../../../../git/light.js';
import {
  Refused,
} from '../../../../../kernel/light.js';

/** Read raw Git output, retaining NUL-delimited names without exposing Git diagnostics. */
export function policyGit(root, args, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the committed coordinator policy or claim base is missing; restore its Git objects or ask the coordinator to refreeze the item');
  return result.stdout;
}

/** Resolve the primary checkout's committed HEAD, independently of a linked or detached checkout. */
export function mainPolicy(root) {
  const checkout = mainCheckout(root);
  if (!checkout) {
    const carried = carriedRunnerTrunk(root);
    if (carried) return policyAt(root, carried.commit);
    throw new Refused('NO_POLICY', 'the coordinator checkout is detached for review; ask it to return to its main branch before claiming or running the project gate');
  }
  if (!checkout.commit) throw new Refused('NO_POLICY', 'the coordinator checkout has no commit on ' + checkout.branch + '; create its first commit before claiming or running the project gate');
  return policyAt(root, checkout.commit);
}

export { trunkRef } from '../../../../../git/light.js';

/** Committed policy bytes by checkout and full commit id; a pinned object never changes, so a long-lived process reuses them. */
const POLICY_SOURCES = new Map();
const POLICY_SOURCE_LIMIT = 64;

/** Re-read coordinator settings from a pinned Git object; never from the candidate filesystem. */
export function policyAt(root, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) throw new Refused('NO_POLICY', 'this item has no recorded claim base; ask the coordinator to refreeze it and claim it again');
  // policyGit runs without replacement objects, so these bytes are exactly the commit's; each caller parses its own copy.
  const key = `${root}\0${commit}`;
  let source = POLICY_SOURCES.get(key);
  if (source === undefined) {
    // Bytes hashing to the blob identity this command already learned are the committed bytes, with no Git child [C7].
    source = pinnedWorkingText(root, commit, 'pullboard.json') ?? policyGit(root, ['show', commit + ':pullboard.json']);
    POLICY_SOURCES.set(key, source);
    if (POLICY_SOURCES.size > POLICY_SOURCE_LIMIT) POLICY_SOURCES.delete(POLICY_SOURCES.keys().next().value);
  }
  return { version: 1, commit, config: configFromSource(source) };
}

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
