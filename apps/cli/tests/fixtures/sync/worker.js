/** The worker side of runCliSync: one awaited in-process CLI call per message, answered on the shared port [C7]. */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';

const { port, signal } = workerData;
Atomics.store(signal, 1, 1);
// Loaded inside the handler, so a failed CLI import is answered to the waiting thread instead of leaving it blocked.
let loaded = null;

/** Post one answer, then wake the waiting test thread. */
function reply(message) {
  port.postMessage(message);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

/** Answer one call with the production dispatch's status and captured output. */
async function answer({ argv, cwd, env }) {
  Atomics.store(signal, 2, 1);
  try {
    loaded ??= import('../process.js');
    const { runCliInProcess } = await loaded;
    Atomics.store(signal, 3, 1);
    const result = await runCliInProcess(argv, { cwd, env });
    reply({ result: { status: result.status, stdout: result.stdout, stderr: result.stderr } });
  } catch (error) {
    reply({ error: { message: String(error?.message ?? error), stack: String(error?.stack ?? '') } });
  }
}

parentPort.on('message', message => { answer(message); });
