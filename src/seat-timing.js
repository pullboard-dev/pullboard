/** Machine-local seat command timing; never placed in a board move or relay [C7,N2]. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Resolve an existing checkout and seat without creating or locking a board. */
export function timingSeat(cwd) {
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 3000, env });
    if (git.status !== 0) return null;
    const [root, common] = git.stdout.trim().split('\n');
    const file = join(common, 'pullboard', 'board.sqlite');
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('SELECT agent_id, agent_path FROM agent').all();
      const seat = rows.find(row => { if (typeof row.agent_path !== 'string') return false; try { return realpathSync(row.agent_path) === realpathSync(root); } catch { return resolve(row.agent_path) === resolve(root); } });
      if (!seat) return null;
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
  if (!binding) return () => {};
  const start = Date.now(), id = randomUUID();
  const base = { version: 1, id, seat: binding.seat, item: item ?? binding.item, kind, command, pid: process.pid, start };
  appendSeatTiming(binding.file, { ...base, phase: 'start' });
  let ended = false;
  const finish = () => { if (ended) return; ended = true; process.removeListener('exit', finish); const end = Date.now(); const held = base.item ?? (kind === 'command' ? timingSeat(cwd)?.item : null) ?? null; appendSeatTiming(binding.file, { ...base, item: held, phase: 'end', end, durationMs: Math.max(0, end - start) }); };
  process.once('exit', finish);
  return finish;
}
