/** The pull path's shared helpers: the bridge reply decoder, output cap, startup deadline, run ceiling and unavailable refusal [C7,#7526]. */
import { Refused } from '../../../kernel/index.js';
import { RunnerDropped } from './result.js';
import { runnerFailure } from './result.js';

// Budget: 64 MiB bounds worst-case JSON bridge escaping below Node string limits.
export const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;

/** Reconstruct the native transport outcome across a fresh controller process. */
export function bridgeResult(request, result, phase) {
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Refused('RUNNER_BRIDGE_DEADLINE', `the runner bridge to ${request.options.runner?.host ?? 'the runner'} ran past its deadline with no result and was ended; its gate slot is released. Rerun the verdict; if it repeats, shout the coordinator with this line`);
  }
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-json'); }
  if (reply.error?.name === 'Refused') {
    const prefix = `[${reply.error.code}] `;
    const refused = new Refused(reply.error.code, reply.error.message.startsWith(prefix) ? reply.error.message.slice(prefix.length) : reply.error.message);
    if (reply.error.runnerAttempt) refused.runnerAttempt = reply.error.runnerAttempt;
    if (reply.error.runnerCancellation) refused.runnerCancellation = reply.error.runnerCancellation;
    if (reply.error.diagnostic) refused.diagnostic = reply.error.diagnostic;
    throw refused;
  }
  if (reply.error?.name === 'RunnerDropped') throw new RunnerDropped(request.options.runner.host, reply.error.diagnostic);
  if (reply.error || result.error || result.status !== 0) throw runnerFailure({ runner: request.options.runner, args: [], phase }, result, 'bridge-exit');
  return reply.result;
}

/**
 * The refusal of a job whose runner went unavailable while it waited for READY. Its diagnostic's reason is
 * runner-unavailable: the gate requeues it as cleanup-unverified, and recordRunnerFailure keeps the runner's existing
 * quarantine instead of writing a second one, so one drop is one quarantine (#3698) [C7].
 *
 * @param {{ runner: { host: string }, spec: { id: string } }} request
 * @param {{ host: string, reason: string }} unavailable - The runner's lease observation.
 * @returns {Refused}
 */
export function runnerUnavailableRefusal(request, unavailable) {
  const error = new Refused('RUNNER_UNAVAILABLE', `runner ${unavailable.host} became ${unavailable.reason} while job ${request.spec.id} waited for READY; release its lease and dispatch once to a healthy runner`);
  error.diagnostic = { ...runnerFailure(request, { status: null, stderr: '' }, 'runner-unavailable').diagnostic,
    unavailable, remoteCleanup: 'unknown' };
  return error;
}

/**
 * The time by which this dispatch's worker must print READY: the lease's queue deadline, or a full startup budget
 * from this dispatch's own start when the lease names one and that ends later. Null means no READY bound.
 * Why: the lease's deadline is when its queue wait ends, fixed at admission. A gate ran doctrine for 177 s on its
 * lease and then sent proof batches with that deadline long past, so each batch was cut off before its worker could
 * answer and logged a missed READY on a healthy runner; 15 of 36 gates did so, one 127 times (#3563, 8 Nov) [C7].
 *
 * @param {{ runnerWaitDeadline?: number, runnerStartupMs?: number }} options
 * @param {number} startedAt - When this dispatch began connecting.
 * @returns {number|null}
 */
export function startupDeadline(options, startedAt) {
  if (!Number.isSafeInteger(options.runnerWaitDeadline)) return null;
  if (!Number.isSafeInteger(options.runnerStartupMs) || options.runnerStartupMs <= 0) return options.runnerWaitDeadline;
  return Math.max(options.runnerWaitDeadline, startedAt + options.runnerStartupMs);
}

/** How long a gate's run may execute after READY with no result when its request names no timeout of its own. */
export const RUN_CEILING_MS = 20 * 60_000;

/**
 * The longest this run may execute after READY before the controller ends it as hung, or null when the run carries
 * its own timeout (a landing or trusted check) or is a main comparison, whose files may legitimately run longer.
 * PULLBOARD_RUNNER_RUN_CEILING_MS overrides the ceiling; 0 turns it off.
 * Why: a gate's item check had no run budget, so a hanging test held #2828's gate and its runner slot for 55 minutes
 * and other gates' for 9 and 11 hours, its heartbeats keeping every watch satisfied (9 Nov) [C7].
 *
 * @param {{ timeoutMs?: number, trustedMode?: { timeoutMs?: number }, landing?: boolean, kind?: string }} spec
 * @param {Record<string, string|undefined>} [env]
 * @returns {number|null}
 */
export function runCeilingMs(spec, env = process.env) {
  if (spec.timeoutMs || spec.trustedMode?.timeoutMs || spec.landing === true || spec.kind === 'main-red') return null;
  const configured = env.PULLBOARD_RUNNER_RUN_CEILING_MS;
  if (configured === undefined || configured === '') return RUN_CEILING_MS;
  const ms = Number(configured);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
