/** Opt-in maintenance settings; filesystem and retirement authority remain with the runner [B3,C7,N26]. */
import { isAbsolute } from 'node:path';

const DURATION = /^(\d+)(ms|s|m|h|d)$/u;
const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_DURATION_MS = 2_147_483_647;
const KEYS = ['enabled', 'every', 'grace', 'exclude'];

/** Fresh defaults never enable a sweep or share a mutable exclusion list. */
export function maintenanceDefaults() { return { enabled: false, every: '1h', grace: '1d', exclude: [] }; }

/** Match the same bounded explicit units accepted by other timeout settings. */
function duration(value) {
  const match = typeof value === 'string' && DURATION.exec(value);
  const ms = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_DURATION_MS ? ms : null;
}

/** Validate recognized coordinator inputs without resolving, creating or touching excluded directories. */
export function maintenanceConfigProblems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['"worktreeMaintenance" is an object with enabled, every, grace and exclude settings'];
  const problems = [];
  if (Object.keys(value).some(key => !KEYS.includes(key)) || KEYS.some(key => !Object.hasOwn(value, key)))
    problems.push('"worktreeMaintenance" has only enabled, every, grace and exclude settings');
  if (typeof value.enabled !== 'boolean') problems.push('"worktreeMaintenance.enabled" is a boolean; false keeps automatic maintenance off');
  for (const key of ['every', 'grace']) if (duration(value[key]) === null)
    problems.push(`"worktreeMaintenance.${key}" is a positive duration no longer than 2,147,483,647ms, using ms, s, m, h or d`);
  if (!Array.isArray(value.exclude) || value.exclude.some(path => typeof path !== 'string' || !path || path.trim() !== path
    || !isAbsolute(path) || /[\u0000-\u001f\u007f-\u009f]/u.test(path)))
    problems.push('"worktreeMaintenance.exclude" is a list of explicit absolute directory paths');
  return problems;
}

/** The scheduler consumes validated durations; this never turns an invalid value into a default. */
export function maintenanceDurations(value) {
  if (maintenanceConfigProblems(value).length) throw new TypeError('invalid worktreeMaintenance settings');
  return { everyMs: duration(value.every), graceMs: duration(value.grace) };
}
