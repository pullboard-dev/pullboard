/** Main's own commits since the last audited tip are an audit obligation, however main moved [C7]. */
import { join } from 'node:path';
import { readMainAudit } from './state.js';

/**
 * Read one Git value, or null when Git refuses.
 *
 * Why: an unknown ref or a root commit's missing parent means "no such commit", never a failed audit.
 */
function maybe(git, root, args) {
  try { return git(root, args).trim() || null; } catch { return null; }
}

/**
 * The commit the audit range starts after: the last green audited tip when it is still on main,
 * otherwise main's tip at the activation boundary, otherwise the tip's first parent.
 * It equals the tip when main has not moved since, so an unmoved main queues nothing.
 */
function auditedBase(git, root, board, directory, activation, tip) {
  const last = readMainAudit(join(directory, 'last-green.json'));
  if (typeof last?.tip === 'string' && /^[a-f0-9]{40,64}$/u.test(last.tip)) {
    try { git(root, ['merge-base', '--is-ancestor', last.tip, tip]); return last.tip; } catch { /* Off main: start at activation. */ }
  }
  const start = board.db.prepare('SELECT event_at FROM event WHERE event_id<=? ORDER BY event_id DESC LIMIT 1').get(activation.afterEventId);
  // Commit dates have whole seconds: a commit in the activation's own second counts as after it.
  const before = start && new Date(Date.parse(start.event_at) - 1000).toISOString();
  const atStart = before && maybe(git, root, ['rev-list', '-1', '--first-parent', `--before=${before}`, tip]);
  return atStart ?? maybe(git, root, ['rev-parse', '--verify', '-q', `${tip}^1`]) ?? tip;
}

/**
 * Items whose `Pullboard-Item: #N` trailers sit in base..tip, with their lanes.
 *
 * Why: hand landings and hotfixes leave no landing batch, so the commits themselves name what landed.
 */
export function itemsBetween(git, root, board, store, base, tip) {
  const log = git(root, ['log', '--format=%B%x00', `${base}..${tip}`]);
  const ids = [...new Set([...log.matchAll(/^Pullboard-Item: #(\d+)\s*$/gmu)].map(match => Number(match[1])))];
  return ids.flatMap(id => {
    try { return [{ id, lane: store.getItem(board, id).item_lane }]; } catch { return []; }
  });
}

/**
 * Queue main's current tip when no landed batch covers it and no green audit has seen it.
 *
 * Why: the batch-only queue never ran, because hand landings and hotfixes emit no landed batch.
 * Auditing main's own tip covers every way main moves; one job per tip keeps the cost to the cadence.
 * The worker passes its own Git runner and board reader, so this module adds no import edge.
 * @returns {object|null} a job in the landed-batch shape, keyed by `main-<tip>`
 */
export function mainCommitJob({ git, store }, root, board, directory, activation, jobs) {
  const tip = maybe(git, root, ['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}']);
  if (!tip || jobs.some(job => job.tip === tip)) return null;
  if (readMainAudit(join(directory, 'last-green.json'))?.tip === tip) return null;
  const base = auditedBase(git, root, board, directory, activation, tip);
  if (base === tip) return null;
  const landedEventId = board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id ?? 0;
  return { version: 1, board: store.boardId(board), batchId: `main-${tip}`, tip,
    tree: git(root, ['rev-parse', `${tip}^{tree}`]).trim(), landedEventId, branch: 'refs/heads/main',
    base, source: 'main-commits', items: itemsBetween(git, root, board, store, base, tip) };
}
