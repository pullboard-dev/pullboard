/** Recorded claim worktrees: background maintenance observes them, board commands only read the record [N2,B3]. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { claimWorktrees } from './worktrees.js';

const memory = new WeakMap();

/**
 * The record sits beside the board file; an in-memory board keeps it on its connection.
 * Why: a command must answer from data already on disk, never by running Git in another seat's worktree (#2427).
 */
function recordFile(board) {
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  return file ? `${file}.worktrees.json` : null;
}

/** Read the board's last recorded observation; a missing or damaged record observes nothing. */
function readRecord(board) {
  const file = recordFile(board);
  if (!file) return memory.get(board.db) ?? null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record?.version === 1 && record.claims && typeof record.claims === 'object' ? record : null;
  } catch { return null; }
}

/**
 * Observe every claimed worktree from Git and record what each changed. Only background maintenance calls this:
 * it is the one place that runs Git in other seats' worktrees.
 */
export function recordClaimWorktrees(board, items, agents, { now = new Date() } = {}) {
  const observed = claimWorktrees(items, agents);
  const seats = new Map(agents.map(agent => [agent.agent_id, agent.agent_path]));
  const claims = {};
  for (const item of items.filter(entry => entry.item_status === 'claimed')) {
    const found = observed.get(item.item_id);
    claims[item.item_id] = { owner: item.item_owner, path: seats.get(item.item_owner) ?? null, claimHead: item.item_claim_head ?? null,
      files: found?.files ?? [], unknown: found?.unknown !== false };
  }
  const record = { version: 1, observedAt: now.toISOString(), claims };
  const file = recordFile(board);
  if (!file) { memory.set(board.db, record); return observed; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* Only this call's own temporary file is removed. */ }
  }
  return observed;
}

/**
 * The recorded files of every claimed worktree, read with no Git. A claim recorded for another holder, seat path or
 * claim head is not this claim's record: it reads as unrecorded until the next maintenance pass observes it.
 * `own` names the caller's checkout: its own claims are observed live, since Git in one's own worktree is its own job.
 */
export function recordedClaimWorktrees(items, agents, board, { own } = {}) {
  const record = board ? readRecord(board) : null;
  const seats = new Map(agents.map(agent => [agent.agent_id, agent.agent_path]));
  return new Map(items.filter(item => item.item_status === 'claimed').map(item => {
    if (own && seats.get(item.item_owner) === own) return [item.item_id, claimWorktrees([item], agents).get(item.item_id)];
    const saved = record?.claims?.[item.item_id];
    const current = saved && saved.owner === item.item_owner && saved.path === (seats.get(item.item_owner) ?? null)
      && saved.claimHead === (item.item_claim_head ?? null) && Array.isArray(saved.files);
    return [item.item_id, current ? { files: saved.files, unknown: saved.unknown === true } : { files: [], unknown: true, unrecorded: true }];
  }));
}
