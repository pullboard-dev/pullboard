/** Typed dependency references, read by seat ordering and the items cell above it [B24,H16,C7]. */
import { Refused } from '../../../kernel/browser.js';

/** Refuse an invalid dependency rather than turning it into NaN or a local item number. */
function invalid() {
  throw new Refused('BAD_DEPENDENCIES', 'use positive item ids or repo#id after --after, separated by commas; use --after none to clear them');
}

/** Parse one exact local or repository-qualified prerequisite without consulting machine state. */
export function parseDependency(value) {
  if (Number.isSafeInteger(value) && value > 0) return { kind: 'local', id: value };
  if (typeof value !== 'string') invalid();
  const local = Number(value.replace(/^#/, ''));
  if (value.trim() && Number.isSafeInteger(local) && local > 0) return { kind: 'local', id: local };
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})#([1-9][0-9]*)$/u.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) invalid();
  return { kind: 'foreign', repo: match[1], id: Number(match[2]) };
}

/** Keep native dependency-edit arrays typed; only CLI and persisted fields decode textual local ids. */
export function validateNativeDependencies(value) {
  if (!Array.isArray(value)) invalid();
  for (const part of value) {
    const reference = parseDependency(part);
    if (reference.kind === 'local' && typeof part !== 'number') invalid();
  }
}

/** Read a persisted comma-separated field or a public dependency list as typed references. */
export function dependencyReferences(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.item_after;
  if (value === undefined || value === null || value === '') return [];
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : invalid();
  return parts.map(parseDependency);
}

/** Local traversal, merge and lane-file inheritance must never consume another board's item id. */
export function localDependencyIds(value) {
  return dependencyReferences(value).filter(ref => ref.kind === 'local').map(ref => ref.id);
}
