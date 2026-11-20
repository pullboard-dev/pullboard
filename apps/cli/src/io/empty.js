/** A submit whose head changes nothing against main is refused before any gate is queued [C7]. */
import { Refused } from '../../../../packages/kernel/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { clauseTicks } from '../../../../packages/state/index.js';
import { criterionClauses } from '../../../../packages/state/index.js';

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
 * Whether an item is proof-only: every clause is declared command, measurement or reasoning and carries its own kind of tick.
 * Why: such an item (#8477, whose three [command] clauses were recorded as facts) has nothing to change, so an empty head is its honest submission (#9105).
 * A [test], [screenshot] or undeclared clause always needs a change.
 * @param {object} item the claimed item row
 * @param {object[]} thread the item's thread, oldest first
 * @param {string} commit the head being submitted
 * @returns {boolean}
 */
export function proofOnlyTicked(item, thread, commit) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length || !clauses.every(clause => ['command', 'measurement', 'reasoning'].includes(clause.kind))) return false;
  const ticks = clauseTicks(thread, item.item_owner, { criterion: item.item_criterion, head: commit });
  return clauses.every(clause => ticks.get(clause.number)?.kind === clause.kind);
}

/**
 * Refuse EMPTY_SUBMIT when the commit's tree equals main's, naming the folder that holds the item's commits.
 * @param {string} root the submitting checkout
 * @param {number|string} id the item id
 * @param {string} commit the head being submitted, after main is composed in
 * @param {string} main the accepted main commit
 * @param {{ proofOnly?: () => boolean, proofShaped?: () => boolean }} [allow] proofOnly reads submit.proofOnly and the item's ticks; proofShaped reads only the ticks, so the refusal can name the setting
 * @returns {void}
 */
export function requireNonEmptySubmit(root, id, commit, main, { proofOnly = () => false, proofShaped = () => false } = {}) {
  if (tryGit(root, ['diff', '--quiet', main, commit]).status === 0 && !landedHotfix(root, id, commit, main) && !proofOnly()) {
    if (proofShaped()) {
      throw new Refused('EMPTY_SUBMIT', `this head has no change against main, and #${id} is a proof-only item with every clause ticked; turn on submit.proofOnly to submit it with no change`);
    }
    const [folder] = itemCommitFolders(root, id, main);
    throw new Refused('EMPTY_SUBMIT', folder
      ? `this head has no change against main; the commits for #${id} are in ${folder}, so cd there and run pullboard submit ${id}`
      : `this head has no change against main and no worktree holds a commit for #${id}; commit the work, then run pullboard submit ${id}`);
  }
}
