/** Closing a materializer whose worker is busy ends the worker within the grace period, not when its work ends [A2,C7]. */
import assert from 'node:assert/strict';
import { BroadcastChannel } from 'node:worker_threads';
import { test } from 'node:test';
import { runUntilExit } from './materializer/exit-fixture.js';
import { startStateMaterializer } from '../../../src/io/state/materializer.js';

/**
 * A ports module (as a data: URL) that blocks the worker for `busyMs` as it starts, telling the channel when it begins
 * and, only if it is allowed to finish, when it ends. Why the start: the worker reads its messages, the close among them,
 * only once it is free, which is exactly what a long build does to a close behind it.
 */
function busyPorts(channel, busyMs) {
  const source = `import { BroadcastChannel } from 'node:worker_threads';
const channel = new BroadcastChannel(${JSON.stringify(channel)});
channel.postMessage('busy');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${busyMs});
channel.postMessage('finished');
channel.close();
export async function boardStatePorts() { return {}; }
`;
  return 'data:text/javascript,' + encodeURIComponent(source);
}

test('clause 1: close() ends a busy state worker within 2 s, before its work would end [A2,C7]', async (t) => {
  const channel = `materializer-close-${process.pid}`;
  const listener = new BroadcastChannel(channel);
  t.after(() => listener.close());
  const heard = (word) => new Promise((resolve) => listener.addEventListener('message', (event) => { if (event.data === word) resolve(word); }));
  const busy = heard('busy');
  const finished = heard('finished');
  const materializer = startStateMaterializer({ portsModule: busyPorts(channel, 3_500), projects: () => [], isMain: true,
    openRevision: () => ({ revision: () => 'r1' }), Refused: class extends Error {} });
  await busy;
  materializer.close();
  // The close message sits behind the worker's work, so only the termination 2 s on can stop it before 3.5 s are up.
  const outcome = await Promise.race([finished, new Promise((resolve) => setTimeout(() => resolve('terminated'), 4_500))]);
  assert.equal(outcome, 'terminated', 'the worker ran its work to its end after the close');
});

test('clause 1: a process holding a materializer with queued builds exits within 2 s of close() [A2,C7]', async () => {
  // The child's worker is blocked for 20 s, as a queued build on a large board blocks it; only the grace timer ends it.
  const source = `import { BroadcastChannel } from 'node:worker_threads';
const { startStateMaterializer } = await import(${JSON.stringify(new URL('../../../src/io/state/materializer.js', import.meta.url).href)});
const ports = ${JSON.stringify(busyPorts('materializer-subprocess', 20_000))};
const channel = new BroadcastChannel('materializer-subprocess');
const busy = new Promise((resolve) => { channel.onmessage = () => resolve(); });
const materializer = startStateMaterializer({ portsModule: ports, projects: () => [], isMain: true,
  openRevision: () => ({ revision: () => 'r1' }), Refused: class extends Error {} });
await busy;
channel.close();
console.log('closing');
materializer.close();`;
  const closedAt = await runUntilExit(source, 10_000);
  assert.ok(closedAt, 'the child never reached close()');
  const took = Date.now() - closedAt;
  assert.ok(took < 5_000, `the process took ${took} ms to exit after close(), with 2 s of grace`); // budget: declared ceiling, the clause allows 5 s for a busy process to exit after close().
});
