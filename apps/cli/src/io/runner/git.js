/** The Git launches a pull serve is handed: the app owns the git I/O, so the drive cell imports no git [C7]. */
import { gitSpawn } from '../../../../../packages/git/light.js';

// Budget: 16 MiB of a git command's output is kept; the serve's commands print a ref list at most.
const KEPT = 16 * 1024 * 1024;

/**
 * Run one git command in a directory without blocking the serve's lease renewals; resolve its status and text.
 * Input is text for stdin, or a stream piped into it (a trunk pack for index-pack).
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {string | import('node:stream').Readable | null} [input]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export function runPullGit(cwd, args, input = null) {
  return new Promise(resolve => {
    const child = gitSpawn(args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', part => { stdout = (stdout + part).slice(-KEPT); });
    child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-KEPT); });
    child.once('error', error => resolve({ status: 1, stdout: stdout.trim(), stderr: error.message }));
    child.once('close', status => resolve({ status: status ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.on('error', () => {});
    if (typeof input?.pipe === 'function') input.once('error', () => child.stdin.destroy()).pipe(child.stdin);
    else child.stdin.end(input ?? undefined);
  });
}

/** What every serveRunner caller passes as its git option: commands by runPullGit, the trunk fetch by the runner's fetch home. */
/** The trunk fetch loads the runner app only when a serve actually fetches, so cold reads never pay for it [C7]. */
async function fetchPullTrunk(store, trunk, refs) {
  const { fetchTrunk } = await import('../../../../runner/index.js');
  return fetchTrunk(runPullGit, store, trunk, refs);
}

export const pullGit = Object.freeze({ run: runPullGit, fetchTrunk: fetchPullTrunk });
