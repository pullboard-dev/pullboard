/** Compose clean main merges, declared lifecycle output and narrowly keyed data manifests [C7,V4]. */
import { mergeableData } from '../logic/manifest.js';
import { createHash } from 'node:crypto';
import { gitExecFileSync } from '../../../git/index.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { resolveMechanicalIndex } from './mechanical.js';
import { Refused } from '../../../kernel/index.js';

const PREPARED = new WeakSet();

/** Use immutable objects and fixed built-in merge rules; never run repository hooks or merge drivers. */
function git(root, args, options = {}) {
  const { allowed = [0], ...execution } = options;
  try { return gitExecFileSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'merge.conflictStyle=merge', '-c', 'merge.renormalize=false', '-c', 'core.attributesFile=/dev/null', ...args],
  { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...execution }); }
  catch (error) { if (allowed.includes(error.status)) return String(error.stdout ?? ''); throw error; }
}

/** Recognize only a composition produced here, not an assertion or descriptor supplied by an agent. */
export function preparedSourceComposition(value) { return PREPARED.has(value); }

/** Read actual conflicting paths before any mechanical filtering; only generated conflicts may auto-resolve here. */
export function sourceConflictFiles(root, inputHead, trunk) {
  const output = git(root, ['merge-tree','--write-tree','--name-only','-z',inputHead,trunk], { allowed: [0,1] }).split('\0');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(output[0] ?? '')) throw new Refused('SOURCE_ADVANCE_SOURCE', 'Git did not return an immutable merge tree');
  const end = output.indexOf('',1);
  return end < 0 ? [] : output.slice(1,end).sort();
}

/** Run work against a private exact merged tree and remove that tree only after its admitted child returns. */
export async function withSourceComposition(root, inputHead, trunk, work) {
  if (![inputHead,trunk].every(value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value ?? ''))) throw new Refused('SOURCE_ADVANCE_SOURCE', 'use exact immutable source and main commits');
  if (git(root, ['config', '--get-regexp', '^merge\\..*\\.driver$'], { stdio: ['ignore','pipe','ignore'], allowed: [0,1] }).trim()) {
    throw new Refused('SOURCE_ADVANCE_SOURCE', 'external merge drivers require an ordinary named conflict return');
  }
  let alreadyContainsMain = false;
  try { git(root, ['merge-base', '--is-ancestor', trunk, inputHead]); alreadyContainsMain = true; }
  catch { /* Distinct divergent or fast-forward source still requires the exact merge and rerun. */ }
  if (alreadyContainsMain) throw new Refused('SOURCE_ADVANCE_SOURCE', 'this exact source already contains main; do not manufacture another merge or receipt');
  return compose(root, inputHead, trunk, work);
}

/** Create a private tree without changing the caller index, checkout, branch, hooks or identity. */
async function compose(root, inputHead, trunk, work) {
  const virtual = git(root, ['merge-tree', '--write-tree', '--name-only', '-z', inputHead, trunk], { stdio: ['ignore','pipe','ignore'], allowed: [0,1] });
  const mergeTree = virtual.split('\0')[0].trim();
  const outer = mkdtempSync(join(tmpdir(), 'pullboard-source-advance-'));
  const directory = join(outer, 'source');
  let added = false;
  let controllerStarted = false;
  let controllerTerminal = false;
  try {
    git(root, ['worktree', 'add', '--detach', directory, inputHead]); added = true;
    let conflicts = [];
    try { git(directory, ['merge', '--no-commit', '--no-ff', trunk], { stdio: ['ignore','pipe','pipe'] }); }
    catch (error) {
      conflicts = git(directory, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean).sort();
      if (!conflicts.length) throw error;
      if (conflicts.some(path => path !== 'docs/lifecycle.md' && !mergeableData(path))) {
        const refusal = new Refused('MERGE_CONFLICT', `main conflicts with ${conflicts.join(', ')}`);
        refusal.files = conflicts; throw refusal;
      }
      const resolved = resolveMechanicalIndex(directory, conflicts, { orderedData: true });
      if (resolved.files.length) {
        const refusal = new Refused('MERGE_CONFLICT', `main conflicts with ${(resolved.rowConflicts ?? resolved.files).join('; ')}`);
        refusal.files = resolved.files; throw refusal;
      }
      if (resolved.failed || resolved.entries.some(entry => entry.kind !== 'generated' && !(mergeableData(entry.path) && entry.kind === 'json'))) {
        throw new Refused('SOURCE_ADVANCE_SOURCE', 'the declared lifecycle generator did not produce the exact merged artifact');
      }
      git(directory, ['add', '--', ...conflicts]);
    }
    const tree = git(directory, ['write-tree']).trim();
    const env = { ...cleanGitEnvironment(), GIT_AUTHOR_NAME: 'Pullboard source merge', GIT_AUTHOR_EMAIL: 'source@pullboard.invalid',
      GIT_COMMITTER_NAME: 'Pullboard source merge', GIT_COMMITTER_EMAIL: 'source@pullboard.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
    const key = createHash('sha256').update(JSON.stringify([inputHead,trunk,tree])).digest('hex');
    const head = git(directory, ['commit-tree', tree, '-p', inputHead, '-p', trunk,
      '-m', `chore(source): merge moved main ${key} [C7,V4]`], { env }).trim();
    git(directory, ['reset', '--hard', head]);
    const paths = git(directory, ['diff', '--no-renames', '--name-only', '-z', trunk, head]).split('\0').filter(Boolean).sort();
    const changed = [...new Set([...paths, ...git(directory, ['diff', '--no-renames', '--name-only', '-z', inputHead, head]).split('\0').filter(Boolean)])].sort();
    const composition = Object.freeze({ directory, inputHead, trunk, head, tree, mergeTree, paths: Object.freeze(paths), changed: Object.freeze(changed), generated: Object.freeze(conflicts) });
    PREPARED.add(composition);
    return await work(composition, Object.freeze({
      /** Mark unknown custody immediately before the actual gate can start an admitted child. */
      started() { controllerStarted = true; },
      /** Only the trusted caller may confirm its actual admitted controller returned without unknown custody. */
      terminal() { controllerTerminal = true; },
    }));
  } finally {
    // A source conflict has no child/controller custody; clear only this private tracked merge before normal removal.
    if (added && (!controllerStarted || controllerTerminal)) {
      git(directory, ['reset', '--hard', inputHead]);
      git(directory, ['clean', '-ffdx']);
    }
    if (added && controllerStarted && !controllerTerminal) throw new Error(`source-advance controller custody is unknown; retain owned source ${directory}`);
    if (added) git(root, ['worktree', 'remove', directory]);
    rmSync(outer, { recursive: true, force: true });
  }
}
