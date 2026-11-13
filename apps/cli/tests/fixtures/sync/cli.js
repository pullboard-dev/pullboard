/** Synchronous production CLI calls answered by one warm worker thread per test file [C7]. */
import { MessageChannel } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import { receiveMessageOnPort } from 'node:worker_threads';

const WAIT_MS = 300_000;
let warm = null;

/** Start the worker once; it stays unreferenced, so the test file exits whenever its tests finish. */
function start() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { port: port2, signal }, transferList: [port2] });
  worker.unref();
  port1.unref();
  const state = { worker, port: port1, signal, exited: null };
  worker.once('error', error => { state.exited = error; });
  worker.once('exit', code => { state.exited ??= new Error(`the fixture CLI worker exited with code ${code}`); });
  return state;
}

/**
 * Run the real CLI dispatch synchronously, as runCliInProcess does, in a warm worker thread.
 * Why: a synchronous fixture such as project() otherwise starts a whole Node process for each setup call; the worker
 * loads the CLI once per test file and answers every later call without a launch. Use it only for setup calls that
 * are not about the process boundary.
 * @param {string[]} argv The command line after `pullboard`.
 * @param {{ cwd: string, env: Record<string, string> }} options The call's directory and complete environment.
 * @returns {{ status: number, stdout: string, stderr: string }} The command's exit status and captured output.
 */
export function runCliSync(argv, { cwd, env }) {
  if (!warm || warm.exited) warm = start();
  Atomics.store(warm.signal, 0, 0);
  warm.worker.postMessage({ argv: [...argv], cwd, env: { ...env } });
  const deadline = Date.now() + WAIT_MS;
  while (Atomics.load(warm.signal, 0) === 0) {
    if (Date.now() >= deadline) throw new Error(`fixture CLI worker gave no answer in ${WAIT_MS} ms: pullboard ${argv.join(' ')}`);
    Atomics.wait(warm.signal, 0, 0, 1_000);
  }
  const reply = receiveMessageOnPort(warm.port)?.message;
  if (!reply) throw new Error(`fixture CLI worker answered without a result: pullboard ${argv.join(' ')}`);
  if (reply.error) throw Object.assign(new Error(reply.error.message), { stack: reply.error.stack });
  return reply.result;
}
