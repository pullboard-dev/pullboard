/**
 * The gate (V4, C3): the repo's own check command, run before submit and before every push. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice. An agent sees a digest of the
 * run, not the run (V10): a passing suite's output costs tokens and says nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gitPath, headTree, isClean, untracked } from './git.js';
import { Refused } from './refused.js';

const STAMP = 'pullboard-gate-green';
const LOG = 'pullboard-gate.log';
const DIGEST_CHARS = 3000;
const FAILURE_RE = /fail|error|expected|received|assert|not ok|✗|×|cannot|undefined|exception/i;

/**
 * The lines of a failure worth an agent's attention: those that look like failures first, then the
 * end of the output, capped, so a refusal or a retry carries the reason and not the whole log.
 *
 * @param {string} output
 * @returns {string}
 */
export function digestOf(output) {
  const lines = output.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const failing = lines.filter((line) => FAILURE_RE.test(line)).slice(0, 25);
  const tail = lines.slice(-15);
  const kept = [...new Set([...failing, ...tail])].join('\n');
  return kept.length > DIGEST_CHARS ? `${kept.slice(0, DIGEST_CHARS)}\n...` : kept;
}

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
 * Run a shell command in a checkout for a digest: both streams in one pipe, in order, read whole
 * however long, stdin closed so nothing waits on a person.
 *
 * @param {string} root
 * @param {string} command
 * @returns {{ isGreen: boolean, output: string, seconds: number }}
 */
export function runShell(root, command) {
  const started = Date.now();
  // Newlines, not spaces, around the command, so a trailing comment in it cannot swallow the `)`.
  const result = spawnSync(`(\n${command}\n) 2>&1`, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 ** 30 });
  return { isGreen: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * Run the configured gate in the repo, unless this exact tree already passed. Its output, both
 * streams in order, is kept whole in the git dir and returned for a digest.
 *
 * @param {string} root
 * @param {any} config
 * @returns {{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string }}
 */
export function runGate(root, config) {
  if (!config.gate.trim()) {
    throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  }
  if (isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const before = committedTree(root);
  const { isGreen, output, seconds } = runShell(root, config.gate);
  const log = gitPath(root, LOG);
  writeFileSync(log, output);
  if (isGreen && before !== null && committedTree(root) === before) {
    writeFileSync(gitPath(root, STAMP), `${before}\n`);
  }
  return { isGreen, isCached: false, output, seconds, log };
}

/**
 * What an agent sees of a gate run (V10): one line when green; when red, the digest and where the
 * whole output is.
 *
 * @param {{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string }} gate
 * @returns {string}
 */
export function gateReport(gate) {
  if (gate.isGreen) return gate.isCached ? 'gate green (this tree already passed)' : `gate green in ${gate.seconds}s`;
  return `gate red in ${gate.seconds}s:\n${digestOf(gate.output).replace(/^/gm, '  ')}\nthe whole output is in ${gate.log}`;
}
