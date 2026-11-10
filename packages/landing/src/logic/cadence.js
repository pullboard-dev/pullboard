/** Opt-in queue triggers and the existing manual start-to-start landing interval [E30,E29]. */
import { landingBatches } from './batch/history.js';
import { acceptedVerdict } from '../../../verify/index.js';

import { cadenceMilliseconds } from '../../../config/index.js';

/** Observe pending native acceptances using their recorded verdict time, never a mutable item update time. */
export function landingCadenceStatus(board, config, now = board.clock.now()) {
  const setting = config.landing?.cadence;
  const everyMs = cadenceMilliseconds(typeof setting === 'string' ? setting : setting?.every);
  const threshold = typeof setting === 'object' ? setting.accepted : null;
  const waiting = board.db.prepare("SELECT * FROM item WHERE item_status='verified' AND item_merged_commit IS NULL").all()
    .map(item => acceptedVerdict(board, item)).filter(Boolean);
  const times = waiting.map(row => Date.parse(row.verdict_at ?? '')).filter(Number.isFinite);
  const oldestWaitMs = times.length ? Math.max(0, now.getTime() - Math.min(...times)) : null;
  const enabled = everyMs !== null;
  const due = enabled && waiting.length > 0 && (oldestWaitMs !== null && oldestWaitMs >= everyMs || threshold !== null && waiting.length >= threshold);
  return { enabled, due, count: waiting.length, threshold, everyMs, oldestWaitMs };
}

/** Explain a no-op in the same units as the configured threshold, including an honestly unknown acceptance time. */
function notDue(board, config, say) {
  const cadence = landingCadenceStatus(board, config);
  if (cadence.due) return null;
  say(`landing not due: ${cadence.enabled ? '' : 'landing.cadence is off; '}count ${cadence.count}/${cadence.threshold ?? 'no count threshold'}; oldest wait ${cadence.oldestWaitMs ?? 'unknown'}ms/${cadence.everyMs ?? 'off'}ms`);
  return { batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], cadence };
}

/**
 * Whether a landing waits on the trunk's landing cadence at all. A landing the automatic lander starts after an accept
 * never does: it starts that item's landing at once (Corey 7 Nov: accepted work waited 20-40 min for hand landing).
 * A hand `pullboard land` and a `land --due` keep the opt-in cadence [C7].
 *
 * @param {{ automatic?: boolean, due?: boolean }} landing - How this landing was started.
 * @returns {boolean}
 */
export function cadenceApplies({ automatic = false, due = false } = {}) {
  return !automatic || due;
}

/** A due call uses queue age/count; ordinary duration calls keep their original start-to-start cooldown. */
export function cadenceDeferral(board, config, branch, say, due = false) {
  if (due) return notDue(board, config, say);
  const interval = typeof config.landing?.cadence === 'string' ? config.landing.cadenceMs : null;
  if (!interval) return null;
  const latest = landingBatches(board).filter(batch => batch.branch === branch).map(batch => Date.parse(batch.startedAt ?? '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (latest === undefined || latest + interval <= board.clock.now().getTime()) return null;
  const deferredUntil = new Date(latest + interval).toISOString();
  say(`landing deferred until ${deferredUntil}: the trunk's landing cadence has not elapsed`);
  return { batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], deferredUntil };
}
