/** Shared elapsed-time policy for coordinator maintenance and read-only status [B4,C7]. */
import { durationMs } from "../../../../../../config/index.js";
import { Refused } from "../../../../../../kernel/light.js";

const MINUTE = 60_000;

/** Read configured limits without loading the Git-aware health scanner on the status path. */
export function staleStateLimits(config = {}, { dependency = false } = {}) {
  const stuck = config.health?.stuck;
  return {
    hold: durationMs(config.health?.holds ?? '1d', 'health.holds'),
    claim: durationMs(stuck ?? '1h', 'health.stuck'),
    blocker: durationMs(stuck ?? '15m', 'health.stuck'),
    review: 30 * MINUTE,
    warning: 60 * MINUTE,
    ...(dependency ? { dependency: durationMs(config.health?.dependencyIdle ?? '2h', 'health.dependencyIdle') } : {}),
  };
}

/** Accept canonical native instants only; malformed or future observations cannot prove inactivity. */
export function staleInstant(value, now) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && new Date(at).toISOString() === value ? at : null;
}

/** Combine every observed activity source, retaining unknown rather than inventing an idle duration. */
export function latestStaleActivity(values, now) {
  const parsed = values.filter(value => value !== null && value !== undefined).map(value => staleInstant(value, now));
  if (!parsed.length || parsed.some(value => value === null)) return null;
  return new Date(Math.max(...parsed)).toISOString();
}

/** Report a half-limit boundary from one clock reading, including exact expiry and remaining time. */
export function staleStateAge(kind, id, actor, since, limitMs, now) {
  const at = staleInstant(since, now);
  if (at === null) return { kind, id, actor, since: null, ageMs: null, limitMs, pastHalf: false, expired: false };
  const ageMs = now - at;
  return { kind, id, actor, since, ageMs, limitMs, pastHalf: ageMs >= limitMs / 2,
    expired: ageMs >= limitMs, expiresAt: new Date(at + limitMs).toISOString() };
}

/** Require a real one-line explanation before coordinator maintenance can free another holder. */
export function staleReleaseNote(note) {
  if (typeof note !== 'string' || !note.trim() || /[\r\n\u2028\u2029]/u.test(note)) {
    throw new Refused('NOTE_REQUIRED', 'release a stale claim with --stale --note "why"');
  }
  return note.trim();
}

/** Format the same explicit age and limit displayed by status and recorded by maintenance. */
export function staleStateLine(entry) {
  const subject = typeof entry.id === 'number' ? `#${entry.id}` : entry.id;
  if (entry.ageMs === null) return `${entry.kind} ${subject}: activity unknown`;
  return `${entry.kind} ${subject}${entry.actor ? ` (${entry.actor})` : ''}: ${Math.floor(entry.ageMs / MINUTE)}m of ${Math.floor(entry.limitMs / MINUTE)}m${entry.expired ? ', expired' : ''}`;
}
