/** Run a gate's shards on the runner's shared channel: start each, then read the result files back [C7]. */
import { Refused } from '../../../kernel/light.js';
import { sharedTransport } from './main.js';
import { ensureTooling } from './tooling.js';

// Budget: one short result read per unfinished shard each second, carried on the runner's one shared channel.
const COLLECT_INTERVAL_MS = 1_000;
// Budget: an invalid result file resets its shard; two restarts, then the gate stops as an infrastructure outcome.
const MAX_RESTARTS = 2;

/** Resolve after ms, or at once when the signal aborts. */
function pause(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Run one gate's shards on a runner over its shared channel and resolve every shard's result.
 *
 * Why: this replaces the per-gate runner controller and its ssh session (design item 10). The Mac holds no process
 * for the gate at all: the shards run detached on the runner, and this loop is a timer reading their result files
 * over the one channel every gate on that runner shares. A lost channel rejects with TRANSPORT_LOST; the shards keep
 * running there, so a rerun of the same job reads what finished instead of starting it again.
 *
 * When a tooling pin is given, the runner is checked first and sent the tooling only if it does not hold that tree;
 * the gate log line says how many tooling bytes were sent.
 *
 * @param {{ runner: object, job: string, owner?: string, shards: { shard: string, command: string, cwd?: string }[],
 *   transport?: { connect: (runner: object) => object }, intervalMs?: number, signal?: AbortSignal,
 *   tooling?: { tree: string, bundle: string }, log?: (line: string) => void }} gate
 * @returns {Promise<{ shard: string, status: number, output: Buffer, digest: string }[]>}
 */
export async function runGate({ runner, job, owner, shards, transport = sharedTransport(), intervalMs = COLLECT_INTERVAL_MS, signal, tooling, log }) {
  if (!Array.isArray(shards) || !shards.length) throw new Refused('TRANSPORT_GATE_SHARDS', `gate ${job} names no shards; plan at least one before running it`);
  const channel = transport.connect(runner);
  if (tooling) await ensureTooling(channel, tooling, log);
  const start = spec => channel.startShard({ job, owner, ...spec });
  for (const spec of shards) await start(spec);
  const results = new Map(), restarts = new Map();
  while (results.size < shards.length) {
    if (signal?.aborted) throw new Refused('TRANSPORT_GATE_STOPPED', `gate ${job} was stopped; its shards keep running on ${runner.host} and a rerun reads their results`);
    for (const spec of shards) {
      if (results.has(spec.shard)) continue;
      const read = await channel.fetchResult({ job, shard: spec.shard });
      if (read.state === 'done') results.set(spec.shard, { shard: spec.shard, status: read.status, output: read.output, digest: read.digest });
      else if (read.state === 'import.invalid' || read.state === 'absent') {
        const count = (restarts.get(spec.shard) ?? 0) + 1;
        if (count > MAX_RESTARTS) throw new Refused('TRANSPORT_IMPORT_INVALID', `shard ${spec.shard} of gate ${job} left no valid result after ${MAX_RESTARTS} restarts on ${runner.host}; requeue the gate on another runner`);
        restarts.set(spec.shard, count);
        await start(spec);
      }
    }
    if (results.size < shards.length) await pause(intervalMs, signal);
  }
  return shards.map(spec => results.get(spec.shard));
}
