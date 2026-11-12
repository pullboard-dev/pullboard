/** Machine-local seat command timing; never placed in a board move or relay [C7,N2]. */
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The seat and item an item folder's private marker names, or null. */
function itemMarker(gitDir) {
  try {
    const marker = JSON.parse(readFileSync(join(gitDir, 'pullboard-item.json'), 'utf8'));
    return typeof marker.seat === 'string' && Number.isSafeInteger(marker.item) ? marker : null;
  } catch { return null; }
}

/** Resolve an existing checkout and seat without creating or locking a board. */
export function timingSeat(cwd) {
  try {
    // Find the worktree's Git metadata without starting Git, including linked worktrees.
    let root = resolve(cwd);
    while (!existsSync(join(root, '.git'))) { const parent = dirname(root); if (parent === root) return null; root = parent; }
    const marker = join(root, '.git');
    let gitDir = marker;
    if (!statSync(marker).isDirectory()) {
      const match = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(marker, 'utf8').trim());
      if (!match) return null;
      gitDir = resolve(root, match[1]);
    }
    const commonFile = join(gitDir, 'commondir');
    const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
    const file = join(common, 'pullboard', 'board.sqlite');
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // The seat registered at this exact path is found by index; only a moved or aliased path reads every seat.
      const exact = db.prepare('SELECT agent_id, agent_path FROM agent WHERE agent_path=?').get(root);
      const rows = exact ? [exact] : db.prepare('SELECT agent_id, agent_path FROM agent').all();
      const found = rows.find(row => { if (typeof row.agent_path !== 'string') return false; try { return realpathSync(row.agent_path) === realpathSync(root); } catch { return resolve(row.agent_path) === resolve(root); } });
      // An item folder names its seat and item in its private marker, so its commit hooks time under that seat (#5719).
      const marker = found ? null : itemMarker(gitDir);
      const seat = found ?? (marker && db.prepare('SELECT agent_id FROM agent WHERE agent_id=?').get(marker.seat));
      if (!seat) return null;
      if (marker) return { seat: seat.agent_id, item: marker.item, file: join(common, 'pullboard', 'seat-timing.jsonl') };
      const item = db.prepare("SELECT item_id FROM item WHERE item_owner=? AND item_status='claimed' ORDER BY item_id LIMIT 1").get(seat.agent_id)?.item_id ?? null;
      return { seat: seat.agent_id, item, file: join(common, 'pullboard', 'seat-timing.jsonl') };
    } finally { db.close(); }
  } catch { return null; }
}

/** Append one bounded record atomically; telemetry never changes command behavior. */
export function appendSeatTiming(file, record) {
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch { /* A read-only checkout must still work. */ }
}

/** Record start immediately and finish even when the caller rejects. */
export function beginSeatTiming(cwd, kind, command, item = null, knownBinding = undefined) {
  const binding = knownBinding === undefined ? timingSeat(cwd) : knownBinding;
  const start = Date.now(), id = randomUUID();
  // A successful join creates its seat during the command; retain that command's true start.
  if (!binding) {
    if (kind !== 'command') return () => {};
    return () => {
      const joined = timingSeat(cwd); if (!joined) return;
      const end = Date.now(), base = { version: 1, id, seat: joined.seat, item: item ?? joined.item, kind, command, pid: process.pid, start };
      appendSeatTiming(joined.file, { ...base, phase: 'start' });
      appendSeatTiming(joined.file, { ...base, phase: 'end', end, durationMs: Math.max(0, end - start) });
    };
  }
  const base = { version: 1, id, seat: binding.seat, item: item ?? binding.item, kind, command, pid: process.pid, start };
  appendSeatTiming(binding.file, { ...base, phase: 'start' });
  let ended = false;
  const finish = () => { if (ended) return; ended = true; process.removeListener('exit', finish); const end = Date.now(); const held = base.item ?? (kind === 'command' ? timingSeat(cwd)?.item : null) ?? null; appendSeatTiming(binding.file, { ...base, item: held, phase: 'end', end, durationMs: Math.max(0, end - start) }); };
  process.once('exit', finish);
  return finish;
}
