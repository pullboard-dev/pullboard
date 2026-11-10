/**
 * The wait audit [C7]: snapshot every wait surface, judge it against its budget, reclaim clearly dead holders, and
 * file one item per distinct cause. `pullboard waits` prints the table; `pullboard waits record` is the built-in
 * sentinel the view runs every minute.
 *
 * Why: on 9 Nov a checkout lease, hung runner jobs, orphaned workers and stalled gates each cost minutes to hours
 * before anyone looked. No hold, wait, queue or process may now exceed its budget silently.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { judgeWaits } from '../logic/budgets.js';
import { sayAge } from '../logic/budgets.js';
import { waitItemDraft } from '../logic/budgets.js';
import { waitKey } from '../logic/budgets.js';
import { localCensus } from './surfaces.js';
import { pidAlive } from './surfaces.js';
import { readBoardWriters } from './surfaces.js';
import { readCheckoutWriters } from './surfaces.js';
import { readHandoffQueue } from './surfaces.js';
import { readHeartbeatClaims } from './surfaces.js';
import { readJobs } from './surfaces.js';
import { readOrphans } from './surfaces.js';
import { readPools } from './surfaces.js';
import { readResourceWriteQueue } from './surfaces.js';
import { readRunnerJobs } from './surfaces.js';

/**
 * Read every surface once. `paths` names the files: { commonDir, boardFile, machineHome, handoffQueue }. Orphans are
 * read last, so every pid a pool, lease or landing run accounts for is exempt from them.
 */
export async function waitsSnapshot({ paths, now = Date.now(), budgets, hosts = [], runnerTimeoutMs = 500, census = localCensus(), readers = {} }) {
  const repoResources = join(paths.commonDir, 'pullboard', 'resources.sqlite');
  const machineResources = join(paths.machineHome, 'resources.sqlite');
  const machine = readPools(machineResources, 'machine', now, census);
  const repo = readPools(repoResources, 'repo', now, census);
  const runners = await (readers.runners ?? readRunnerJobs)(hosts, now, { timeoutMs: runnerTimeoutMs });
  const rows = [
    ...repo.rows, ...machine.rows, ...machine.unavailable,
    ...readCheckoutWriters(paths.commonDir, now, census),
    ...readBoardWriters(paths.boardFile, now, census),
    ...readResourceWriteQueue(machineResources, now, census),
    ...readResourceWriteQueue(repoResources, now, census),
    ...readHandoffQueue(paths.handoffQueue, now, census),
    ...readJobs(paths.boardFile, join(paths.commonDir, 'pullboard', 'gate-spans'), now, census),
    ...readHeartbeatClaims(paths.boardFile, now, census, readers.heartbeat ?? {}),
    ...runners.rows,
  ];
  const accounted = new Set(rows.flatMap(row => [row.surface !== 'heartbeat-loop' ? row.pid : null, ...(row.waiters ?? []).map(waiter => waiter.pid)]).filter(Number.isSafeInteger));
  rows.push(...readOrphans(census, accounted).filter(row => !rows.some(other => other.pid === row.pid && other.surface === 'heartbeat-loop')));
  const judged = judgeWaits(rows, budgets).sort((a, b) => Number(b.breach) - Number(a.breach) || b.ageMs - a.ageMs);
  return { at: new Date(now).toISOString(), budgets, rows: judged, notes: runners.notes };
}

/** One table line per row: surface, holder, age, waiters and budget, breaches marked first. */
export function waitLines(snapshot) {
  const lines = snapshot.rows.map(row => `${row.breach ? 'OVER' : row.dead ? 'DEAD' : 'ok  '}  ${row.surface.padEnd(16)} ${sayAge(row.ageMs).padStart(7)} / ${sayAge(row.budgetMs).padEnd(6)}`
    + `  ${row.holder}${row.pid ? ` (pid ${row.pid})` : ''}${row.waiters.length ? `; ${row.waiters.length} waiting, oldest ${sayAge(row.oldestWaiterMs)}` : ''}`
    + `${row.context ? `\n        doing: ${row.context}` : ''}${row.detail ? `\n        ${row.detail}` : ''}`);
  const over = snapshot.rows.filter(row => row.breach).length;
  lines.push(`${snapshot.rows.length} waits; ${over} over budget${snapshot.notes.length ? `; ${snapshot.notes.join('; ')}` : ''}`);
  return lines;
}

/**
 * Stop one process by exact pid with SIGTERM, only after proving it is still the orphan observed: same start time,
 * and its parent gone (ppid 1, or a parent no longer running).
 */
function terminateOrphan(pid, started) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=,lstart='], { encoding: 'utf8', timeout: 2_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
  const words = String(result.stdout ?? '').trim().split(/\s+/u);
  if (result.status !== 0 || words.length < 6) return false;
  const ppid = Number(words[0]);
  if (words.slice(1, 6).join(' ') !== started || !(ppid === 1 || !pidAlive(ppid))) return false;
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

/** Remove a file a dead holder left, saying whether it went. */
function removeDead(file) {
  try { unlinkSync(file); return true; } catch { return false; }
}

/**
 * Reclaim each clearly dead holder at once, then file one item per new cause and record the run in one shout.
 * Ports keep this testable on a real board: openKey(key) says whether an open item carries the key, fileItem(draft)
 * files one, shout(text) records, prunePools(scope) runs the queue's own prune, release(heartbeat) frees a claim.
 */
export async function recordWaits(snapshot, { openKey, fileItem, shout, prunePools = () => {}, release = async () => false, terminate = terminateOrphan, remove = removeDead }) {
  const { budgets } = snapshot;
  const reclaimed = [], filed = [], deduplicated = [], notes = [];
  const handled = new Set();
  if (budgets.reclaim) {
    const scopes = new Set();
    for (const row of snapshot.rows) {
      if (row.dead?.kind === 'pool') scopes.add(row.dead.scope);
      if (row.dead?.kind === 'file') {
        const gone = row.dead.files.filter(file => (row.dead.pid === undefined || !pidAlive(row.dead.pid)) && remove(file));
        if (gone.length) { reclaimed.push(`${row.surface} ${row.holder}: removed ${gone.length} record${gone.length === 1 ? '' : 's'} of a gone pid (${row.evidence})`); handled.add(row); }
      }
      if (row.dead?.kind === 'lock') {
        let text = null;
        try { text = readFileSync(row.dead.file, 'utf8'); } catch { /* Released meanwhile. */ }
        if (text === row.dead.text && !pidAlive(row.dead.pid) && remove(row.dead.file)) { reclaimed.push(`${row.surface}: removed writer.lock of gone pid ${row.dead.pid}`); handled.add(row); }
      }
      const orphanDue = row.surface === 'heartbeat-loop' || row.breach;
      if (row.orphan && orphanDue && terminate(row.orphan.pid, row.orphan.started)) {
        reclaimed.push(`${row.surface} ${row.holder}: SIGTERM pid ${row.orphan.pid}, parent gone, ${sayAge(row.ageMs)} old`);
        handled.add(row);
      }
    }
    for (const scope of scopes) {
      try { prunePools(scope); reclaimed.push(`${scope} pools: pruned holders of gone pids`); }
      catch (error) { notes.push(`${scope} pools not pruned: ${error.code ?? error.message}`); }
      for (const row of snapshot.rows) if (row.dead?.kind === 'pool' && row.dead.scope === scope) handled.add(row);
    }
    for (const row of snapshot.rows) {
      const loops = row.heartbeat?.loops ?? [];
      if (row.surface !== 'heartbeat-claim' || !row.breach || !loops.length || !loops.every(loop => loop.orphaned)) continue;
      // The loops were stopped above when they were orphaned; the claim goes back so next hands it to a live seat.
      for (const loop of loops) if (pidAlive(loop.pid)) terminate(loop.pid, loop.started);
      try {
        if (await release(row.heartbeat)) { reclaimed.push(`#${row.heartbeat.item}: released from ${row.heartbeat.seat}, whose heartbeat loop was orphaned`); handled.add(row); }
      } catch (error) { notes.push(`#${row.heartbeat.item} not released yet: ${error.code ?? error.message}`); }
    }
  }
  for (const row of snapshot.rows) {
    if (!row.breach || handled.has(row) || !budgets.file) continue;
    const key = waitKey(row);
    if (openKey(key)) { deduplicated.push(key); continue; }
    const draft = waitItemDraft(row);
    filed.push({ id: await fileItem(draft), key, title: draft.title });
  }
  if (filed.length || reclaimed.length) {
    await shout(waitShout(snapshot.rows.filter(row => row.breach).length, filed.map(row => row.id), reclaimed.length));
  }
  return { filed, deduplicated, reclaimed, notes };
}

/** A shout is at most 400 characters; the audit's line stays well under it and names at most this many ids. */
const SHOUT_MAX = 300;

/**
 * One short line for the coordinator: how many waits are over budget, the items filed and how many holders were
 * reclaimed. The detail lives in the filed items and `pullboard waits`, never in the shout, which the board caps.
 */
function waitShout(over, ids, reclaimed) {
  const tail = `, reclaimed ${reclaimed}; pullboard waits for detail`;
  let shown = ids.map(id => `#${id}`);
  const line = list => `waits: ${over} over budget, ${ids.length ? `filed ${list.join(' ')}${list.length < ids.length ? ` and ${ids.length - list.length} more` : ''}` : 'filed none'}${tail}`;
  while (shown.length && line(shown).length > SHOUT_MAX) shown = shown.slice(0, -1);
  return line(shown);
}

/** Whether an open, claimed or submitted item's brief already carries this wait key. */
export function openWaitKey(db, key) {
  return Boolean(db.prepare("SELECT 1 FROM item WHERE item_status IN ('open', 'claimed', 'submitted') AND instr(item_brief, ?) > 0 LIMIT 1").get(`Wait key: ${key}`));
}
