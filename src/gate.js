/**
 * The gate (V4, C3): the repo's own check command, run before submit and before every push. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice. An agent sees a digest of the
 * run, not the run (V10): a passing suite's output costs tokens and says nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gitChildEnv, gitPath, headTree, isClean, untracked } from './git.js';
import { Refused } from './refused.js';
import { takeResource } from './resources.js';
import { loadMachineSettings } from './settings.js';

const STAMP = 'pullboard-gate-green';
const LOG = 'pullboard-gate.log';
const DIGEST_CHARS = 3000;
const TAIL_CHARS = 1000;
const LINE_CHARS = 300;
const FAILURE_RE = /fail|error|expected|received|assert|not ok|✗|×|cannot|undefined|exception/i;
// A passing test's own lines, whatever its name says: TAP's `ok N` and the `# Subtest:` before it.
const PASSING_RE = /^\s*(ok \d+\b|# Subtest:)/;
// Lines kept under a failure, where test runners say why: the message, expected and actual.
const CONTEXT_LINES = 10;

/**
 * The lines of a failure worth an agent's attention: each line that looks like a failure with the
 * lines under it that say why, then the end of the output, within one cap, so a refusal or a retry
 * carries the reason and not the whole log. Passing tests are skipped however they are named. The
 * end has its own share of the cap and every line is cut short, so no single long line can push the
 * summary out.
 *
 * @param {string} output
 * @returns {string}
 */
export function digestOf(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line));
  const tail = [];
  let room = TAIL_CHARS;
  for (let at = lines.length - 1; at >= 0 && tail.length < 15 && lines[at].length < room; at -= 1) {
    tail.unshift(lines[at]);
    room -= lines[at].length + 1;
  }
  room = DIGEST_CHARS - (TAIL_CHARS - room);
  const body = lines.slice(0, lines.length - tail.length);
  const failing = [];
  for (let at = 0; at < body.length && failing.length < 40; at += 1) {
    if (PASSING_RE.test(body[at]) || !FAILURE_RE.test(body[at])) continue;
    const block = body.slice(at, at + CONTEXT_LINES + 1);
    const end = block.findIndex((line, n) => n > 0 && (PASSING_RE.test(line) || /^\s*(not ok \d+|\.\.\.)\s*$|^\s*not ok \d+/.test(line)));
    for (const line of end === -1 ? block : block.slice(0, end)) {
      if (line.length >= room) break;
      failing.push(line);
      room -= line.length + 1;
    }
    at += (end === -1 ? block.length : end) - 1;
  }
  return [...failing, ...tail].join('\n');
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
  const result = spawnSync(`(\n${command}\n) 2>&1`, { cwd: root, env: gitChildEnv(root), shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 ** 30 });
  return { isGreen: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * Run the configured gate in the repo, unless this exact tree already passed. Its output, both
 * streams in order, is kept whole in the git dir and returned for a digest.
 *
 * A passed tree is marked by a stamp file in the git dir, which any agent can write. So the stamp
 * only saves a run where nothing is proven by it, such as pre-push (C3); submit needs a run of its
 * own and passes `trustStamp: false` (V16).
 *
 * @param {string} root
 * @param {any} config
 * @param {{ trustStamp?: boolean, onWait?: (state: object) => void, landing?: boolean }} [options]
 * @returns {Promise<{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string }>}
 */
export async function runGate(root, config, { trustStamp = true, onWait, landing = false } = {}) {
  if (!config.gate.trim()) {
    throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  }
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const capacityProvider = () => loadMachineSettings().gateSlots;
  const lease = await takeResource({
    name: 'gate',
    capacity: capacityProvider(),
    capacityProvider,
    scope: 'machine',
    root,
    repo: root,
    landing,
    allowIdleCapacityUpdate: true,
    onWait,
  });
  try {
    if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
    const before = committedTree(root);
    const { isGreen, output, seconds } = runShell(root, config.gate);
    const log = gitPath(root, LOG);
    writeFileSync(log, output);
    if (isGreen && before !== null && committedTree(root) === before) {
      writeFileSync(gitPath(root, STAMP), `${before}\n`);
    }
    return { isGreen, isCached: false, output, seconds, log };
  } finally {
    lease.release();
  }
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
