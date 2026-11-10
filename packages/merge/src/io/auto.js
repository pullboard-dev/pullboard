/** Compose a clean accepted-main move in the builder's checkout without inventing content [C7,V4]. */
import { cleanGitEnvironment } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/** Merge an exact main commit only when Git reports no conflict, using the invoking builder’s Git identity. */
export function mergeSubmissionMain(root, main) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(main)) throw new Refused('NO_POLICY', 'read an exact accepted main before composing the submission');
  const env = cleanGitEnvironment();
  const source = git(root, ['rev-parse', 'HEAD'], { env });
  if (tryGit(root, ['merge-base', '--is-ancestor', main, source], { env }).status === 0) return { source, commit: source, merged: false };
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'], { env })) throw new Refused('DIRTY', 'commit all changes before merging current main');
  const tree = tryGit(root, ['merge-tree', '--write-tree', '--name-only', '-z', source, main], { env });
  const fields = tree.stdout.split('\0');
  if (tree.status !== 0) {
    const paths = fields.slice(1, fields.indexOf('', 1) < 0 ? undefined : fields.indexOf('', 1)).filter(Boolean);
    if (paths.length) throw new Refused('MERGE_CONFLICT', `main conflicts in ${paths.map(path => JSON.stringify(path)).join(', ')}; resolve and commit those files`);
    throw new Refused('MERGE_CHECK_FAILED', 'Git could not compute the exact main merge; inspect its output and retry');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(fields[0])) throw new Refused('MERGE_CHECK_FAILED', 'Git did not return a valid merge tree');
  const identityEnv = { ...env };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    if (process.env[key] !== undefined) identityEnv[key] = process.env[key];
  }
  const merged = tryGit(root, ['merge', '--no-ff', '--no-edit', '-m',
    `Merge main ${main.slice(0, 12)} into the submitted source`, main], { env: identityEnv });
  if (merged.status !== 0) throw new Refused('MERGE_CHECK_FAILED', `the clean merge could not be committed: ${merged.stderr || merged.stdout}`);
  const commit = git(root, ['rev-parse', 'HEAD'], { env });
  const parents = git(root, ['show', '-s', '--format=%P', commit], { env }).split(' ');
  if (git(root, ['rev-parse', `${commit}^{tree}`], { env }) !== fields[0] || parents.length !== 2 || parents[0] !== source || parents[1] !== main) {
    throw new Refused('MERGE_CHECK_FAILED', 'the committed merge differs from Git\'s exact clean composition; inspect the checkout before retrying');
  }
  return { source, commit, merged: true };
}
