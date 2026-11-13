/** The ssh bursts a pulled job spends on its runner (cancel, ack, and running the shared enqueue, pack and fetch scripts of scripts.js) over the job's own ssh options [C7,#5465]. */
import { spawnSsh } from '../../../../transport/index.js';
import { shellWord } from '../tooling/remote.js';
import { sshEnvironment } from '../tooling/remote.js';
import { createReadStream } from 'node:fs';

/** Budget: a burst that has not ended in this long is a hung transport, never a slow job. */
const BURST_MS = 120_000;
/** Budget: matches the controller's bound on retained runner output. */
export const MAX_FETCH_BYTES = 64 * 1024 ** 2;

/** The runner's pull root as a shell word: its configured root, else the same default home folder the worker installs under. */
export function pullRoot(runner) {
  return runner.root ? shellWord(runner.root) : '"$HOME"/.pullboard-runner';
}

/** The ssh options of a job's own launch, minus its host and remote command: the same credential-free policy. */
export function sshOptions(args) { return args.slice(0, -2); }

/** Shell that asks a job to stop: a queued row is removed, a running one gets its cancel mark. */
export function cancelScript(runner, id) {
  return ['umask 077', `R=${pullRoot(runner)}`, `if [ -d "$R/running/${id}" ]; then : > "$R/running/${id}/cancel"; elif [ -d "$R/done/${id}" ]; then :; else rm -rf "$R/queue/${id}"; fi`].join('\n');
}

/** Shell that forgets a finished job on the runner. */
export function ackScript(runner, id) {
  return ['R=' + pullRoot(runner), `rm -rf "$R/done/${id}" "$R/running/${id}" "$R/queue/${id}" "$R/queue/.tmp-${id}"`].join('\n');
}

/**
 * Run one script over a fresh ssh session and collect its answer.
 *
 * @param {{ args: string[], env?: object }} job - The job's ssh options and host, as its request built them.
 * @param {string} script - The remote shell text.
 * @param {{ input?: Buffer, inputFile?: string, onStdout?: (chunk: Buffer) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: Buffer, stderr: string, error?: Error }>}
 *   stdout is empty when `onStdout` takes the stream.
 */
export function sshBurst(job, script, { input, inputFile, onStdout, signal } = {}) {
  return new Promise(resolve => {
    const host = job.args.at(-2);
    const child = spawnSsh([...sshOptions(job.args), host, script], { env: job.env ?? sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let bytes = 0, error, finished = false;
    const stop = reason => { error ??= reason; child.kill('SIGTERM'); };
    const timer = setTimeout(() => stop(new Error('runner transfer exceeded its ceiling')), BURST_MS);
    const abort = () => stop(new Error('runner transfer canceled'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_FETCH_BYTES + 1024) return stop(Object.assign(new Error('runner output exceeded 64 MiB; reduce command output or keep this run local'), { code: 'RUNNER_OUTPUT_LIMIT' }));
      if (onStdout) onStdout(chunk); else out.push(chunk);
    });
    child.stderr.on('data', chunk => { err.push(chunk); if (err.length > 64) err.shift(); });
    child.on('error', failure => { error ??= failure; });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure; });
    child.once('close', (status, killed) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ status, signal: killed, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8').slice(-8192), ...(error ? { error } : {}) });
    });
    if (inputFile) createReadStream(inputFile).on('error', failure => stop(failure)).pipe(child.stdin);
    else child.stdin.end(input);
  });
}

/** True when a burst ended cleanly: exit 0 and no local transport error. */
export function burstOk(result) { return result.status === 0 && !result.error; }
