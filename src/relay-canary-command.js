/** Explicit machine-local canary commands; all messages retain the caller's ordinary authority [H5,H17]. */
import { realpathSync } from 'node:fs';
import {
  context,
  ordered,
  withBoard,
  whoAmI,
} from './cli.js';
import { COORDINATOR } from './config.js';
import { PERSON } from './board.js';
import { laneNames } from './lanes.js';
import { Refused } from './refused.js';
import {
  relayMachineContext,
  relayStatus,
} from './relay.js';
import {
  loadMachineSettings,
  setRelayCanary,
} from './settings.js';
import { relayCanaryConfig } from './relay-canary-config.js';
import { readRelayHealth } from './relay-canary-health.js';
import {
  startRelayCanaryWatch,
  runRelayCanary,
} from './relay-canary-watch.js';

/** Read telemetry without contacting the relay or creating a health observation. */
function status(root, config) {
  let queued = 0;
  try { queued = relayStatus(root).outbox?.length ?? 0; }
  catch { /* An absent local link cannot establish current relay health. */ }
  return { config, health: readRelayHealth(root, { queued }) };
}

/** Bind an explicit run to the configured checkout and its ordinary joined seat. */
function requireSeat(ctx, board, config) {
  const me = whoAmI(ctx, board);
  if (me.id === COORDINATOR || me.id === PERSON || !me.id
    || realpathSync(ctx.info.root) !== realpathSync(config.root) || me.id !== config.agentId) {
    throw new Refused('RELAY_CANARY_SEAT', 'run the canary from its configured ordinary joined seat; do not borrow a coordinator or another seat');
  }
  return me;
}

/** Record each notification through ordinary native transport; failure leaves the durable notice pending. */
async function notify(ctx, config, notice, observation) {
  const delayed = !observation.ok || Date.parse(observation.at) > Date.parse(notice.at) ? 'DELAYED: relay delivery is pending; this is a local native notice, not a phone acknowledgement. ' : '';
  const text = `${delayed}Relay canary ${notice.kind} at ${notice.at}: ${notice.step} (${notice.code}). Inspect pullboard relay canary status; keep working locally.`;
  // A provisional local queue entry is not the native acknowledgment that clears a durable canary notice.
  const notification = { ...ctx, io: { ...ctx.io, relayCanary: true } };
  await withBoard(notification, async board => {
    const me = requireSeat(notification, board, config);
    for (const to of [COORDINATOR, PERSON]) {
      await ordered(notification, board, 'shout', [{ from: me.id, to, text, lanes: laneNames(ctx.config), decision: false }]);
    }
  });
}

/** Run `relay canary on|off|status|run`; the lazy relay dispatcher supplies the subcommand in first. */
export async function run(io, { first = 'status', second, rest = [], values = {} }) {
  if (!['on', 'off', 'status', 'run', 'watch'].includes(first) || second || rest.length
    || values.url || values.all || values.skip || (values.timeout !== undefined && first !== 'on')) {
    throw new Refused('USAGE', 'pullboard relay canary on [--timeout <milliseconds>], off, status, run, or watch');
  }
  const ctx = context(io);
  let config = relayCanaryConfig(loadMachineSettings().relay?.canary);
  if (first === 'watch') return watch(ctx, config);
  if (first === 'on') {
    const linked = relayMachineContext(ctx.info.root);
    if (!linked || linked.environment) throw new Refused('RELAY_NOT_LINKED', 'link this dedicated canary seat normally before enabling its watch; environment credentials do not configure a canary');
    config = withBoard(ctx, board => {
      const me = whoAmI(ctx, board);
      const selected = relayCanaryConfig({ enabled: true, root: realpathSync(ctx.info.root), agentId: me.id,
        deadlineMs: values.timeout === undefined ? 5000 : Number(values.timeout) });
      requireSeat(ctx, board, selected);
      return setRelayCanary(selected);
    });
  } else if (first === 'off') {
    config = setRelayCanary(config ? { ...config, enabled: false } : null);
  } else if (first === 'run') {
    if (!config?.enabled) throw new Refused('RELAY_CANARY_CONFIG', 'enable this machine’s dedicated canary with pullboard relay canary on');
    withBoard(ctx, board => requireSeat(ctx, board, config));
    const controller = new AbortController();
    let interrupted = 0;
    /** Abort owned transport first; the awaited probe drains before the command returns. */
    const interrupt = code => { interrupted ||= code; controller.abort(); };
    const onInterrupt = () => interrupt(130);
    const onTerminate = () => interrupt(143);
    const onParentAbort = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    io.relaySignal?.addEventListener('abort', onParentAbort, { once: true });
    if (io.relaySignal?.aborted) controller.abort();
    let result;
    try {
      result = await runRelayCanary(config, { io: { ...io, relaySignal: controller.signal }, notify: (notice, observation) => {
        if (controller.signal.aborted) throw new Refused('RELAY_CANARY_STOPPED', 'the canary stopped; pending notifications remain for its next ordinary run');
        return notify({ ...ctx, io: { ...io, relaySignal: controller.signal } }, config, notice, observation);
      } });
    } catch (error) {
      io.say('DELAYED: the probe or native notification did not finish; durable pending notices are retained, with no phone acknowledgement claimed.');
      if (interrupted) return interrupted;
      throw error;
    } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      io.relaySignal?.removeEventListener('abort', onParentAbort);
    }
    io.result?.(result);
    io.say(result.health.text);
    if (result.health.pendingNotifications) io.say('DELAYED: canary notifications remain pending; no phone acknowledgement has been observed.');
    return interrupted || (result.observation.ok ? 0 : 1);
  }
  const result = status(ctx.info.root, config);
  io.result?.(result);
  io.say(`Relay canary ${config?.enabled ? 'on' : 'off'}. ${result.health.text}`);
  if (result.health.pendingNotifications) io.say('DELAYED: canary notifications remain pending; no phone acknowledgement has been observed.');
  return 0;
}

/** Keep one explicitly requested watch alive, stopping only after its active ordinary probe drains. */
async function watch(ctx, config) {
  if (!config?.enabled) throw new Refused('RELAY_CANARY_CONFIG', 'enable this machine’s dedicated canary with pullboard relay canary on');
  withBoard(ctx, board => requireSeat(ctx, board, config));
  let stopped;
  let status = 0;
  const done = new Promise(resolve => { stopped = resolve; });
  const observer = startRelayCanaryWatch({ keepAlive: true,
    run: (selected, { io }) => {
      withBoard(ctx, board => requireSeat(ctx, board, selected));
      const current = { ...ctx, io: { ...ctx.io, ...io } };
      return runRelayCanary(selected, { io: current.io, notify: (notice, observation) => notify(current, selected, notice, observation) });
    },
    onError: error => ctx.io.err(`Relay canary has a pending observation or notice (${error.code ?? 'RELAY_CANARY_FAILURE'}); the next minute retries it.`),
  });
  /** Stop further scheduling, abort owned I/O and let native receipt cleanup finish before returning. */
  const stop = code => { status ||= code; void observer.close().then(stopped, stopped); };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  ctx.io.say('Relay canary watch runs every minute; stop it with Ctrl-C.');
  try { await done; }
  finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    await observer.close();
  }
  return status;
}
