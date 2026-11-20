/**
 * The wait audit [C7]: snapshot every wait surface, judge it against its budget, reclaim clearly dead holders, and
 * file one item per distinct cause. `pullboard waits` prints the table; `pullboard waits record` is the built-in
 * sentinel the view runs every minute.
 *
 * Why: on 9 Nov a checkout lease, hung runner jobs, orphaned workers and stalled gates each cost minutes to hours
 * before anyone looked. No hold, wait, queue or process may now exceed its budget silently.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { judgeWaits } from '../logic/budgets.js';
import { sayAge } from '../logic/budgets.js';
import { waitItemDraft } from '../logic/budgets.js';
import { waitKey } from '../logic/budgets.js';
import { boardWritesLog } from '../../../store/index.js';
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
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** The most recent bytes of board-writes.jsonl read: the log grows without bound and a marker is minutes old. */
const WRITE_LOG_TAIL_BYTES = 4 * 1024 * 1024;
/** The recorded writes one over-budget board-write row names, the longest first. */
const RECORDED_HOLDS_MAX = 12;

/**
 * Every write the machine recorded in its board write log (a bounded tail): { at, heldMs, command, seat, item, pid,
 * phase, move, step, boardFile }. A missing or unreadable log is no rows, never a failed audit.
 */
export function readBoardWriteLog(file) {
  let fd;
  try {
    fd = fs.open(file, 'r');
    const { size } = fs.fstat(fd);
    const start = Math.max(0, size - WRITE_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const text = buffer.subarray(0, fs.read(fd, buffer, 0, buffer.length, start)).toString('utf8');
    return (start ? text.slice(text.indexOf('\n') + 1) : text).split('\n').filter(Boolean).flatMap(line => {
      try {
        const row = JSON.parse(line);
        return Number.isFinite(Date.parse(row.at)) && Number.isFinite(row.heldMs) ? [{ ...row, start: Date.parse(row.at) }] : [];
      } catch { return []; }
    });
  } catch { return []; }
  finally { if (fd !== undefined) try { fs.close(fd); } catch { /* A read-only audit ignores a close failure. */ } }
}

/**
 * Attach to each over-budget board-write row the recorded writes over budget whose hold overlaps the marker's age.
 * Why: a write-holders marker is published before the writer waits for SQLite, so its age may be waiting, not holding;
 * the writes that really held the lock in that span are in the machine's board write log, and the filed bar names them.
 */
function attachRecordedHolds(rows, now, boardFile, readLog) {
  if (!rows.some(row => row.surface === 'board-write' && row.breach && row.pid)) return rows;
  let here = boardFile;
  try { here = fs.realpath(boardFile); } catch { /* A board file not on disk keeps its given path. */ }
  const log = readLog();
  return rows.map(row => {
    if (row.surface !== 'board-write' || !row.breach || !row.pid) return row;
    const markerStart = now - row.ageMs;
    const recordedHolds = log
      .filter(hold => hold.heldMs > row.budgetMs && hold.start < now && hold.start + hold.heldMs > markerStart && [undefined, null, boardFile, here].includes(hold.boardFile))
      .sort((a, b) => b.heldMs - a.heldMs).slice(0, RECORDED_HOLDS_MAX)
      .map(({ command, seat, item, pid, heldMs, phase, move, step }) => ({ command, seat, item: item ?? null, pid: pid ?? null, heldMs, phase, move, step }));
    return { ...row, recordedHolds };
  });
}

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
  // A runner whose worker is running a job right now is busy, not unavailable: a quarantine row it still carries is no wait (#7626).
  const busyHosts = new Set(runners.rows.filter(row => row.working).map(row => row.host));
  const rows = [
    ...repo.rows, ...machine.rows, ...machine.unavailable.filter(row => !busyHosts.has(row.holder)),
    ...readCheckoutWriters(paths.commonDir, now, census).filter(row => !clearedDeadWriter(row)),
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
  const judged = attachRecordedHolds(judgeWaits(rows, budgets), now, paths.boardFile, readers.boardWrites ?? (() => readBoardWriteLog(boardWritesLog())))
    .sort((a, b) => Number(b.breach) - Number(a.breach) || b.ageMs - a.ageMs);
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

/**
 * Whether a checkout-writer row is a gone pid's record, removed here so a plain read never lists it as DEAD.
 * Why: only the coordinator's recordWaits cleared these records, so a trial board kept printing one after its item landed; takeover already removes a gone pid's record, so removing it on read is safe [C7].
 */
function clearedDeadWriter(row) {
  return row.surface === 'checkout-writer' && row.dead?.kind === 'file' && !pidAlive(row.dead.pid) && row.dead.files.every(removeDead);
}

/** Remove a file a dead holder left, saying whether it went. */
function removeDead(file) {
  try { fs.unlink(file); return true; } catch { return false; }
}

/**
 * Reclaim each clearly dead holder at once, then file one item per new cause and record the run in one shout.
 * observeHolder(row), when given (sentinels.recordWriteHolder on), keeps each over-budget live board write's holder.
 * Ports keep this testable on a real board: openKey(key) says whether an open item carries the key, fileItem(draft)
 * files one, shout(text) records, prunePools(scope) runs the queue's own prune, release(heartbeat) frees a claim.
 */
export async function recordWaits(snapshot, { openKey, repeat = async () => {}, fileItem, shout, prunePools = () => {}, release = async () => false, terminate = terminateOrphan, remove = removeDead, observeHolder = null }) {
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
        try { text = fs.readFile(row.dead.file, 'utf8'); } catch { /* Released meanwhile. */ }
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
  if (observeHolder) {
    for (const row of snapshot.rows) if (row.breach && row.surface === 'board-write' && row.pid) observeHolder(row);
  }
  for (const row of snapshot.rows) {
    if (!row.breach || handled.has(row) || !budgets.file) continue;
    const key = waitKey(row);
    const open = openKey(key);
    if (open) {
      deduplicated.push(key);
      // A repeat with a new holder adds a fact to the open item; the port skips a pid it already recorded [C7].
      if (Number.isSafeInteger(open)) await repeat(open, `Again over budget: ${row.holder}${row.pid ? ` (pid ${row.pid})` : ''}, ${sayAge(row.ageMs)} held`, row.pid ?? null);
      continue;
    }
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

/** The id of the open, claimed or submitted item whose brief carries this wait key, or 0. */
export function openWaitKey(db, key) {
  return db.prepare("SELECT item_id FROM item WHERE item_status IN ('open', 'claimed', 'submitted') AND instr(item_brief, ?) > 0 ORDER BY item_id LIMIT 1").get(`Wait key: ${key}`)?.item_id ?? 0;
}

/** Whether an item's brief or thread already names this holder pid, so a repeat of the same holder adds no second fact. */
export function waitPidRecorded(db, id, pid) {
  const mark = `(pid ${pid})`;
  return Boolean(db.prepare("SELECT 1 FROM item WHERE item_id = ? AND instr(item_brief, ?) > 0").get(id, mark)
    || db.prepare("SELECT 1 FROM event WHERE item_id = ? AND instr(event_detail, ?) > 0 LIMIT 1").get(id, mark));
}
