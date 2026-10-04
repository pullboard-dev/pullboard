/**
 * The gate (V4, C3): the repo's own check command, run before submit and before every push. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gitPath, headTree, isClean, untracked } from './git.js';
import { Refused } from './refused.js';

const STAMP = 'pullboard-gate-green';

/**
 * The tree a gate run would check, or null when the working copy differs from HEAD or holds
 * untracked files, since a pass over it would vouch for something no commit holds.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function committedTree(root) {
  if (!isClean(root) || untracked(root).length) return null;
  return headTree(root);
}

/**
 * True when the gate already passed on exactly this committed tree.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isStampedGreen(root) {
  const tree = committedTree(root);
  const file = gitPath(root, STAMP);
  return tree !== null && existsSync(file) && readFileSync(file, 'utf8').trim() === tree;
}

/**
 * Run the configured gate in the repo, unless this exact tree already passed.
 *
 * @param {string} root
 * @param {any} config
 * @param {{ stdio?: 'inherit' | 'pipe' }} [options]
 * @returns {{ isGreen: boolean, isCached: boolean, output: string }}
 */
export function runGate(root, config, { stdio = 'inherit' } = {}) {
  if (!config.gate.trim()) {
    throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  }
  if (isStampedGreen(root)) return { isGreen: true, isCached: true, output: '' };
  const before = committedTree(root);
  const result = spawnSync(config.gate, { cwd: root, shell: true, stdio, encoding: 'utf8' });
  const isGreen = result.status === 0;
  const output = stdio === 'pipe' ? `${result.stdout ?? ''}${result.stderr ?? ''}` : '';
  if (isGreen && before !== null && committedTree(root) === before) {
    writeFileSync(gitPath(root, STAMP), `${before}\n`);
  }
  return { isGreen, isCached: false, output };
}
