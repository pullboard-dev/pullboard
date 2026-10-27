/** Opt-in queue triggers and the existing manual start-to-start landing interval [E30,E29]. */
import { landingBatches } from './landing-batch-history.js';
import { acceptedVerdict } from './verdict-reviews.js';

const DURATION = /^(\d+)(ms|s|m|h|d)$/u;
const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse the existing bounded duration syntax without changing its timeout-compatible range. */
export function cadenceMilliseconds(value) {
  const match = typeof value === 'string' && DURATION.exec(value);
  const ms = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 2_147_483_647 ? ms : null;
}

/** Validate only the new object form; unknown keys cannot silently create a scheduling policy. */
export function cadenceProblem(value) {
  if (value === undefined || cadenceMilliseconds(value) !== null) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['every', 'accepted'].includes(key))
    && cadenceMilliseconds(value.every) !== null && Number.isSafeInteger(value.accepted) && value.accepted > 0) return null;
  return '"landing.cadence" is a positive duration, or {every: "10m", accepted: 5} with a positive whole accepted count';
}

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
