/** The runner-channel registry: connect(runner) reuses one live channel per runner from its adapter [C7]. */
import { Refused } from '../../../kernel/core.js';
import { channelKey } from '../core/frames.js';
import { sshAdapter } from './ssh.js';

/**
 * Build a transport over a runner adapter. An adapter has open(runner), which returns a channel with startShard,
 * fetchResult, resetShard, alive, onLost and close, and probe(runner). The SSH push adapter is the default; a pull
 * adapter for hosted sandboxes plugs in the same way (design §10). Passing open or launch builds the SSH adapter
 * over those process seams.
 *
 * Why: every gate on a runner shares one channel, so the Mac holds one connection per runner instead of one
 * controller and ssh session per gate; the probe never rides the channel, so a busy or wedged channel cannot fake
 * a healthy runner and a failed probe never ends the gates still using it.
 *
 * @param {{ adapter?: object, open?: Function, launch?: Function, now?: () => number, timeoutMs?: number,
 *   probeTimeoutMs?: number }} [options]
 * @returns {{ connect: Function, probe: Function, channels: Function, close: Function }}
 */
export function createTransport({ adapter, ...processes } = {}) {
  const runners = adapter ?? sshAdapter(processes);
  const live = new Map();

  /** The runner's live channel, opened on first use and replaced only after it is lost. */
  function connect(runner) {
    const key = channelKey(runner);
    const existing = live.get(key);
    if (existing?.alive) return existing;
    const channel = runners.open(runner);
    live.set(key, channel);
    channel.onLost(() => { if (live.get(key) === channel) live.delete(key); });
    return channel;
  }

  return {
    connect,
    /** The adapter's own check that the runner answers, apart from its channel. */
    probe: runner => { channelKey(runner); return runners.probe(runner); },
    /** The live channels, one per runner host. */
    channels: () => [...live.values()],
    /** Close every live channel. */
    close() { for (const channel of [...live.values()]) channel.close(); live.clear(); },
  };
}

let shared = null;

/** The process-wide transport over SSH, made on first use so importing the cell starts nothing. */
export function sharedTransport() {
  shared ??= createTransport();
  return shared;
}

/** The runner's one reused channel on the process-wide transport. */
export function connect(runner) {
  return sharedTransport().connect(runner);
}

/** A probe of the runner on the process-wide transport, separate from its channel. */
export function probe(runner) {
  return sharedTransport().probe(runner);
}

/** The channel a shard call goes to: a channel itself, or the runner's channel on the process-wide transport. */
function channelFor(target) {
  if (typeof target?.startShard === 'function') return target;
  if (typeof target?.host === 'string') return connect(target);
  throw new Refused('TRANSPORT_CHANNEL', 'a shard call needs a channel from connect(runner) or a runner with a host');
}

/**
 * Start one shard on the runner: its job and command files are written there and the command runs detached, so its
 * result file is written whether or not this channel or its driver is still there; a shard already started or done
 * is left alone. Resolves { state: started | running | done, job, shard }.
 */
export function startShard(target, spec) {
  return channelFor(target).startShard(spec);
}

/**
 * Read a shard's result file, checked against the digest a done step recorded when given. Resolves
 * { state: absent | running }, { state: done, status, output, digest }, or { state: import.invalid, reason, digest,
 * reset: true } after the shard's files are removed so it reads as not started.
 */
export function fetchResult(target, spec) {
  return channelFor(target).fetchResult(spec);
}
