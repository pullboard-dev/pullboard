/**
 * One cold next with no process launch: a fresh worker thread loads the CLI for the first time and answers one
 * call, reporting how long its event loop sat idle and which git processes it started [C7,#8574].
 * Why: a warm in-process call reuses the caches a real `pullboard next` starts without, so it hides both costs.
 */
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import childProcess from 'node:child_process';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/** The command a child-process call starts, as its program's base name. */
function program(args) {
  const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
  return command.split('/').pop();
}

/** Worker side: count this thread's git children, then time one next from a cold module graph. */
async function answer({ argv, cwd, env }) {
  const started = [];
  for (const api of APIS) {
    const real = childProcess[api];
    childProcess[api] = function counted(...args) {
      if (program(args) === 'git') {
        const cwd = args.find(arg => typeof arg?.cwd === 'string')?.cwd ?? '';
        started.push(`${(Array.isArray(args[1]) ? args[1] : []).slice(0, 8).join(' ')} (in ${cwd.split('/').slice(-2).join('/')}) ${new Error().stack.split('\n').slice(5, 12).map(line => line.trim().replace(/^at /u, '').replace(/\(.*\/(.+?:\d+):\d+\)/u, '($1)')).join(' < ')}`);
      }
      return real.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  const { runCliInProcess } = await import('./process.js');
  const before = performance.eventLoopUtilization();
  const result = await runCliInProcess(argv, { cwd, env });
  const loop = performance.eventLoopUtilization(before);
  parentPort.postMessage({ status: result.status, out: result.stdout, err: result.stderr, idleMs: loop.idle, git: started });
}

if (!isMainThread && workerData?.kind === 'cold-next') answer(workerData).catch(error => parentPort.postMessage({ error: String(error?.stack ?? error) }));

/**
 * Run `pullboard <argv>` once in a fresh worker thread and return its answer, loop idle time and git children.
 * @param {string} cwd the seat folder
 * @param {Record<string, string>} env the box's complete environment
 * @param {string[]} [argv]
 * @returns {Promise<{ status: number, out: string, err: string, idleMs: number, git: string[] }>}
 */
export async function coldNext(cwd, env, argv = ['next']) {
  const plain = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])); // A box env may carry non-cloneable members; the worker needs plain strings.
  const worker = new Worker(new URL(import.meta.url), { execArgv: [], env: plain, workerData: { kind: 'cold-next', argv, cwd, env: plain } });
  try {
    const reply = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`the cold next worker exited with code ${code} before answering`)));
    });
    if (reply.error) throw new Error(reply.error);
    return reply;
  } finally { await worker.terminate(); }
}
