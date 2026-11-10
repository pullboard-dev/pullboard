/** A submit whose head changes nothing against main is refused before any gate is queued [C7]. */
import { Refused } from '../../../../packages/kernel/index.js';
import { tryGit } from '../../../../packages/git/index.js';

/**
 * The worktree folders of the repository that hold commits citing the item and differ from main.
 * Why: a stale seat folder submits main itself, and the builder needs the folder that really holds the work.
 * @param {string} root a checkout of the repository
 * @param {number|string} id the item id
 * @param {string} main the accepted main commit
 * @returns {string[]} folder paths, newest evidence first
 */
export function itemCommitFolders(root, id, main) {
  const listed = tryGit(root, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return [];
  const folders = [];
  for (const block of listed.stdout.split('\n\n')) {
    const path = /^worktree (.+)$/mu.exec(block)?.[1];
    const head = /^HEAD ([0-9a-f]{40})$/mu.exec(block)?.[1];
    if (!path || !head || head === main || path === root) continue;
    const cited = tryGit(path, ['log', '--format=%H', '-1', `--grep=Pullboard-Item: #${id}$`, `${main}..${head}`]);
    if (cited.status === 0 && cited.stdout) folders.push(path);
  }
  return folders;
}

/**
 * Whether the head is a commit citing this item that is already on main and changes something against its own parent.
 * Why: a coordinator hotfix lands before its post-hoc review, so measured against main it is empty; against its
 * parent it is the change under review (#2633 was refused EMPTY_SUBMIT this way).
 * @param {string} root a checkout of the repository
 * @param {number|string} id the item id
 * @param {string} commit the head being submitted
 * @param {string} main the accepted main commit
 * @returns {boolean}
 */
export function landedHotfix(root, id, commit, main) {
  if (tryGit(root, ['merge-base', '--is-ancestor', commit, main]).status !== 0) return false;
  const cited = tryGit(root, ['log', '-1', '--format=%H', `--grep=Pullboard-Item: #${id}$`, commit]);
  if (cited.status !== 0 || cited.stdout.trim() !== commit) return false;
  return tryGit(root, ['diff', '--quiet', `${commit}^`, commit]).status === 1;
}

/**
 * Refuse EMPTY_SUBMIT when the commit's tree equals main's, naming the folder that holds the item's commits.
 * @param {string} root the submitting checkout
 * @param {number|string} id the item id
 * @param {string} commit the head being submitted, after main is composed in
 * @param {string} main the accepted main commit
 * @returns {void}
 */
export function requireNonEmptySubmit(root, id, commit, main) {
  if (tryGit(root, ['diff', '--quiet', main, commit]).status === 0 && !landedHotfix(root, id, commit, main)) {
    const [folder] = itemCommitFolders(root, id, main);
    throw new Refused('EMPTY_SUBMIT', folder
      ? `this head has no change against main; the commits for #${id} are in ${folder}, so cd there and run pullboard submit ${id}`
      : `this head has no change against main and no worktree holds a commit for #${id}; commit the work, then run pullboard submit ${id}`);
  }
}
