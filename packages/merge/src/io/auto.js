/** Compose a clean accepted-main move in the builder's checkout without inventing content [C7,V4]. */
import { cleanGitEnvironment } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/**
 * Merge an exact main commit only when Git reports no conflict, using the invoking builder’s Git identity.
 *
 * With `checkout: false` the merge is written as Git objects only: the builder's checkout, index and HEAD stay put and no
 * working-tree update or merge hook runs. Why: the checkout was the slowest phase of submit (4.6 s idle, 14-31 s loaded);
 * the gate only needs the composed commit, which the submit pins for the runner [C7].
 */
export function mergeSubmissionMain(root, main, { checkout = true } = {}) {
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
  if (!checkout) {
    const message = `Merge main ${main.slice(0, 12)} into the submitted source`;
    const written = tryGit(root, ['commit-tree', fields[0], '-p', source, '-p', main, '-m', message], { env: identityEnv });
    if (written.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(written.stdout.trim())) throw new Refused('MERGE_CHECK_FAILED', `the clean merge could not be written: ${written.stderr || written.stdout}`);
    return { source, commit: written.stdout.trim(), merged: true };
  }
  const merged = tryGit(root, ['merge', '--no-ff', '--no-edit', '-m',
    `Merge main ${main.slice(0, 12)} into the submitted source`, main], { env: identityEnv });
  if (merged.status !== 0) {
    // A refusing merge hook (NOT_JOINED, BOARD_BUSY) leaves MERGE_HEAD and staged files; clear them so a rerun starts clean.
    tryGit(root, ['merge', '--abort'], { env });
    throw new Refused('MERGE_CHECK_FAILED', `the clean merge could not be committed: ${merged.stderr || merged.stdout}`);
  }
  const commit = git(root, ['rev-parse', 'HEAD'], { env });
  const parents = git(root, ['show', '-s', '--format=%P', commit], { env }).split(' ');
  if (git(root, ['rev-parse', `${commit}^{tree}`], { env }) !== fields[0] || parents.length !== 2 || parents[0] !== source || parents[1] !== main) {
    throw new Refused('MERGE_CHECK_FAILED', 'the committed merge differs from Git\'s exact clean composition; inspect the checkout before retrying');
  }
  return { source, commit, merged: true };
}

/** The ref that keeps a submit composition reachable, so git gc cannot drop it before landing: one per item and main [C7,U159]. */
export function composeRef(item, main) {
  return `refs/pullboard/compose/${item}/${String(main).slice(0, 12)}`;
}

/**
 * Compose an exact main commit with the builder's head as a throwaway commit object, never a branch commit [C7,U159].
 *
 * The composition is a pure function of (main, head): `merge-tree --write-tree` then `commit-tree` with parents main then
 * head, identity "Pullboard compose", kept under refs/pullboard/compose/<item>/<main12>. HEAD, the index, the checkout and
 * the branch never move and no hook runs, so the builder's branch gets no sync merge. A runner or lander can recompute
 * the same tree id from the two commits alone. Why: a sync merge in the builder's branch was a third of all commits and
 * stale again by landing; the proof needs the composed tree, not a builder commit.
 *
 * @param {string} root - The builder checkout.
 * @param {string} main - The exact accepted main commit.
 * @param {{ item: number|string }} options - The item whose composition ref is written.
 * @returns {{ source: string, commit: string, merged: boolean, composed: boolean, ref?: string, tree?: string }}
 */
export function composeSubmissionMain(root, main, { item } = {}) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(main)) throw new Refused('NO_POLICY', 'read an exact accepted main before composing the submission');
  if (!/^[1-9]\d*$/u.test(String(item ?? ''))) throw new Refused('MERGE_CHECK_FAILED', 'a submit composition needs the item id for its ref');
  const env = cleanGitEnvironment();
  const source = git(root, ['rev-parse', 'HEAD'], { env });
  if (tryGit(root, ['merge-base', '--is-ancestor', main, source], { env }).status === 0) return { source, commit: source, merged: false, composed: false };
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'], { env })) throw new Refused('DIRTY', 'commit all changes before submitting');
  if (tryGit(root, ['config', '--get-regexp', '^merge\\..*\\.driver$'], { env }).stdout.trim())
    throw new Refused('MERGE_CHECK_FAILED', 'external merge drivers cannot establish an exact submit composition; remove the merge driver or merge main yourself, then submit again');
  const merged = tryGit(root, ['merge-tree', '--write-tree', '--name-only', '-z', main, source], { env });
  const fields = merged.stdout.split('\0');
  if (merged.status !== 0) {
    const end = fields.indexOf('', 1);
    const paths = fields.slice(1, end < 0 ? undefined : end).filter(Boolean);
    if (paths.length) throw new Refused('MERGE_CONFLICT', `main conflicts in ${paths.map(path => JSON.stringify(path)).join(', ')}; resolve and commit those files`);
    throw new Refused('MERGE_CHECK_FAILED', 'Git could not compute the exact main composition; inspect its output and retry');
  }
  const tree = fields[0].trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Refused('MERGE_CHECK_FAILED', 'Git did not return a valid composition tree');
  const identity = { ...env, GIT_AUTHOR_NAME: 'Pullboard compose', GIT_AUTHOR_EMAIL: 'compose@pullboard.invalid',
    GIT_COMMITTER_NAME: 'Pullboard compose', GIT_COMMITTER_EMAIL: 'compose@pullboard.invalid' };
  const message = `Compose main ${main.slice(0, 12)} with #${item} head ${source.slice(0, 12)}`;
  const written = tryGit(root, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', main, '-p', source, '-m', message], { env: identity });
  const commit = written.stdout.trim();
  if (written.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Refused('MERGE_CHECK_FAILED', `the composition could not be written: ${written.stderr || written.stdout}`);
  const ref = composeRef(item, main);
  const kept = tryGit(root, ['update-ref', '-m', `pullboard compose #${item}`, ref, commit], { env });
  if (kept.status !== 0) throw new Refused('MERGE_CHECK_FAILED', `the composition ref ${ref} could not be written: ${kept.stderr || kept.stdout}`);
  return { source, commit, merged: true, composed: true, ref, tree };
}
