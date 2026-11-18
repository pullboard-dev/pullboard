/** Whether a light door is main's own door, read from git when main's folder holds no files (a pull runner's no-checkout clone) [C7]. */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { resolve } from 'node:path';
import { gitSpawn } from '../../../../git/index.js';

/**
 * Run one git command in a checkout and collect its exit status and stdout; a failure to start reads as status 1.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<{ status: number, out: string }>}
 */
function gitRun(root, args) {
  return new Promise(done => {
    let out = '';
    const child = gitSpawn(['--literal-pathspecs', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => done({ status: 1, out: '' }));
    child.on('close', status => done({ status: status ?? 1, out }));
  });
}

/**
 * A module and every repo file it reaches by a relative static or literal dynamic import, sorted.
 *
 * @param {string} root
 * @param {string} door - Repo-relative module path.
 * @param {(source: string) => { specifier: string }[]} specifiersOf - The relative import specifiers of a source.
 * @returns {string[]} Repo-relative paths that exist in the checkout.
 */
export function importClosure(root, door, specifiersOf) {
  const seen = new Set();
  const queue = [door];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    let source;
    try { source = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
    seen.add(file);
    for (const { specifier } of specifiersOf(source)) queue.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
  }
  return [...seen].sort();
}

/**
 * Whether a door and everything it imports are byte for byte what main held where the candidate forked from it, so
 * the door is main's and its load time is not the candidate's doing. The fork point, not main's tip, is the base:
 * main landing a change behind the door after the fork is not the candidate's change.
 * Why: a pull runner's job checkout is a worktree of a no-checkout clone; main's folder holds only .git, so without
 * this every light door on a loaded runner met the absolute budget alone, and a run at main itself read red [C7].
 *
 * @param {string} root - The candidate checkout.
 * @param {string} door - Repo-relative module path.
 * @param {(source: string) => { specifier: string }[]} specifiersOf
 * @returns {Promise<boolean>} False when any file differs, is new, or git cannot tell.
 */
export async function doorMatchesMain(root, door, specifiersOf) {
  const files = importClosure(root, door, specifiersOf);
  if (!files.includes(door)) return false;
  const fork = await gitRun(root, ['merge-base', 'HEAD', 'main']);
  const base = fork.out.trim();
  if (fork.status !== 0 || !/^[0-9a-f]{40,64}$/u.test(base)) return false;
  const listed = await gitRun(root, ['ls-tree', '-r', '--name-only', base, '--', ...files]);
  if (listed.status !== 0 || listed.out.split('\n').filter(Boolean).length !== files.length) return false;
  return (await gitRun(root, ['diff', '--quiet', base, '--', ...files])).status === 0;
}
