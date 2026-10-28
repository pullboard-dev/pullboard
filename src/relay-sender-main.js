/** CLI-owned composition and process launch for the machine relay sender [H21,H16,C7]. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRelaySender } from './relay-sender-worker.js';
import { outboxWaiting } from './relay-outbox.js';

/** The actual CLI composition entry executed by background sender processes. */
export const SENDER_WORKER = fileURLToPath(import.meta.url);

/** Launch one detached native sender using the already-filtered caller environment. */
export function launchRelaySender(root, env) {
  const child = spawn(process.execPath, [SENDER_WORKER], { cwd: root, detached: true, stdio: 'ignore', env });
  child.unref();
}

/** Send and pull one board under its relay lock, then run the person's waiting requests. True when nothing waits. */
async function serve(root, file, io) {
  const { syncRelay } = await import('./relay.js');
  const { relayOutboxSetting } = await import('./cli.js');
  const boardIo = { ...io, launchRelaySender, relayOutbox: () => relayOutboxSetting(root) };
  await syncRelay(root, boardIo);
  try {
    const { executePersonRequests } = await import('./relay-request-execution.js');
    const { main } = await import('./cli-main.js');
    await executePersonRequests(root, boardIo, main);
  } catch (error) { io.err(`person requests not run: ${error.message}`); }
  return !outboxWaiting(file);
}

if (process.argv[1] && resolve(process.argv[1]) === SENDER_WORKER) await runRelaySender({ serve });
