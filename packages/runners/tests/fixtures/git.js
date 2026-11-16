/** The git runner runners' tests hand checkoutCandidate: plain git child processes, so no test imports the app [C7]. */
import { spawn } from 'node:child_process';

// Budget: 16 MiB of a git command's output is kept, matching the app's runner.
const KEPT = 16 * 1024 * 1024;

/**
 * Run one git command in a directory without blocking; resolve its status and text.
 * Input is text for stdin, or a stream piped into it (a trunk pack for index-pack).
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {string | import('node:stream').Readable | null} [input]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export function runTestGit(cwd, args, input = null) {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
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

/** The `{ run, fetchTrunk }` git option, shaped like the app's pullGit; the trunk fetch is the runner's one-line fetch. */
export const testGit = Object.freeze({
  run: runTestGit,
  fetchTrunk: (store, trunk, refs) => runTestGit(store, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--', trunk, ...refs]),
});
