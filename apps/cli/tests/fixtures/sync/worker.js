/** The worker side of runCliSync: one awaited in-process CLI call per message, answered on the shared port [C7]. */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';
import { runCliInProcess } from '../process.js';

const { port, signal } = workerData;

/** Answer one call, then wake the waiting test thread. */
async function answer({ argv, cwd, env }) {
  try {
    const result = await runCliInProcess(argv, { cwd, env });
    port.postMessage({ result: { status: result.status, stdout: result.stdout, stderr: result.stderr } });
  } catch (error) {
    port.postMessage({ error: { message: String(error?.message ?? error), stack: String(error?.stack ?? '') } });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

parentPort.on('message', message => { answer(message); });
