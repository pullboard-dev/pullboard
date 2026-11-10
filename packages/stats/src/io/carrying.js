/** Read recorded lifecycle clocks and exact committed paths without modifying a board or repository [R1,R2]. */
import { gitSpawnSync } from '../../../git/index.js';
import { cleanGitEnvironment } from '../../../git/index.js';
import { carryingCapacity } from '../logic/carrying.js';

const HOUR = 3_600_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Read one exact source diff, preserving unusual path bytes through NUL separation. */
function changedFiles(root, commit, base) {
  if (!SHA.test(commit ?? '')) return null;
  const args = SHA.test(base ?? '')
    ? ['diff', '--name-only', '--no-renames', '-z', base, commit, '--']
    : ['diff-tree', '--root', '--diff-merges=first-parent', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit, '--'];
  const result = gitSpawnSync(['--no-optional-locks', '--no-replace-objects', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? [...new Set(String(result.stdout ?? '').split('\0').filter(Boolean))] : null;
}

/** Invalid recorded detail stays unknown; current mutable rows never repair historical observations. */
function detailOf(event) {
  try { return typeof event.event_detail === 'string' ? JSON.parse(event.event_detail) : event.event_detail ?? {}; }
  catch { return {}; }
}

/** Capture completed claim/build/wait boundaries and file attribution once per immutable source. */
export function readCarryingCapacity(root, events, { from, to }) {
  const end = Date.parse(to), start = Date.parse(from);
  const histories = new Map(), landings = [], conflicts = [], fileCache = new Map();
  /** Shared Git objects, including batch commits, are read once per exact source/base pair. */
  function filesAt(commit, base) {
    const key = `${base ?? ''}:${commit ?? ''}`;
    if (!fileCache.has(key)) fileCache.set(key, changedFiles(root, commit, base));
    return fileCache.get(key);
  }
  for (const event of [...events].sort((a, b) => a.event_id - b.event_id)) {
    const at = Date.parse(event.event_at);
    if (!Number.isFinite(at) || at >= end || event.item_id == null) continue;
    const detail = detailOf(event);
    if (!histories.has(event.item_id)) histories.set(event.item_id, { start: null, buildFrom: null, buildMs: 0, invalid: false, submission: null });
    const item = histories.get(event.item_id);
    if (item.landed) continue;
    if (event.event_kind === 'reopen' && detail.conflict) {
      conflicts.push({ at, files: Array.isArray(detail.conflict.files) && detail.conflict.files.length
        && detail.conflict.files.every(file => typeof file === 'string' && file.length) ? [...new Set(detail.conflict.files)] : null });
    }
    if (event.event_kind === 'claim') {
      item.start ??= at;
      item.buildFrom ??= at; // renewals extend the same observed build, not an extra interval
    }
    if (['submit', 'release', 'lapse', 'withdraw'].includes(event.event_kind) && item.buildFrom !== null) {
      if (at < item.buildFrom) item.invalid = true;
      else item.buildMs += at - item.buildFrom;
      item.buildFrom = null;
    }
    if (event.event_kind === 'submit') item.submission = { commit: detail.commit, base: detail.submissionSize?.head === detail.commit ? detail.submissionSize.base : null };
    if (event.event_kind !== 'merged') continue;
    const lifetime = item.start === null || item.invalid || at < item.start || item.buildFrom !== null ? null : (at - item.start) / HOUR;
    const build = lifetime === null || item.buildMs / HOUR > lifetime ? null : item.buildMs / HOUR;
    if (at >= start) landings.push({ item: event.item_id, at, commit: detail.commit,
      files: item.submission?.base ? filesAt(item.submission.commit, item.submission.base) : filesAt(detail.commit, null),
      lifetimeHours: lifetime, buildHours: build, waitingHours: build === null ? null : lifetime - build });
    // A merged item is terminal. Duplicate merged records are not new observed landings.
    histories.set(event.item_id, { ...item, landed: true });
  }
  return carryingCapacity({ landings, conflicts, from, to });
}
