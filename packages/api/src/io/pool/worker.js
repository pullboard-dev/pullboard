/** @pullboard-module-loads apps/cli/src/io/commands/serve.js */
/**
 * One handler pool worker: it runs one call at a time on its own board connections and posts the value or the error
 * back by the call's id [A2,C7]. The ports module composes the board openers and the gate's providers here, since a
 * worker cannot be handed functions; its handlers, when it names any, replace the pool's own (a test's blocking hook).
 */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';

// Node 22 announces that node:sqlite is experimental; the request thread drops that notice, and so does this one,
// before the board modules load: why they are imported below rather than hoisted.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};
const { poolHandlers } = await import('./handlers.js');
const { boardHandlerPorts } = await import(workerData.portsModule);
const ports = await boardHandlerPorts();
const handlers = { ...poolHandlers(ports, { isMain: workerData.isMain }), ...ports.handlers };

parentPort.on('message', async ({ id, kind, args }) => {
  try {
    if (typeof handlers[kind] !== 'function') throw Object.assign(new Error(`no pool handler ${kind}`), { name: 'Error' });
    parentPort.postMessage({ id, value: await handlers[kind](args) });
  } catch (error) {
    parentPort.postMessage({ id, error: { name: error?.name, code: error?.code, message: error?.message ?? String(error), next: error?.next, stack: error?.stack } });
  }
});
