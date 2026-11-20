/** Recover conflicting local Git-sharing artifacts without rewriting board history [H11,C7]. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { gitSyncCompatibility } from '../main.js';
import { inspectGitSyncLock } from './lock.js';
import { withGitSyncLock } from './lock.js';
import { gitSyncFiles } from '../../../../config/index.js';
import { readGitSyncMarker } from '../../../../config/index.js';
import { Refused } from '../../../../kernel/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** Retain one exact conflicting marker under its own immutable recovery summary. */
function quarantineMarker(root, observed, owner, lease) {
  lease.assertHeld();
  const { marker, quarantine } = gitSyncFiles(root);
  let current;
  try { current = fs.lstat(marker); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!observed.stat || current.dev !== observed.stat.dev || current.ino !== observed.stat.ino
    || current.mtimeMs !== observed.stat.mtimeMs || current.size !== observed.stat.size) return null;
  fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
  const parent = fs.lstat(quarantine);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Refused('GIT_SYNC_LOCAL_CHANGED',
    'Git sync recovery evidence needs a real local quarantine directory; the original marker was preserved',
    'restore the quarantine directory without deleting the original evidence');
  const at = new Date().toISOString();
  const folder = join(quarantine, `git-sync-${Date.now()}-${randomUUID()}`);
  fs.mkdir(folder, { mode: 0o700 });
  lease.assertHeld();
  const destination = join(folder, 'git-sync.json');
  fs.rename(marker, destination);
  const writer = observed.value?.writer;
  const summary = { version: 1, at, reason: 'foreign-marker', artifacts: [{ name: 'git-sync.json',
    path: destination, pid: Number.isSafeInteger(writer?.pid) ? writer.pid : owner.pid ?? null,
    command: typeof writer?.command === 'string' ? writer.command : owner.command ?? 'unknown',
    at: typeof writer?.at === 'string' ? writer.at : at, sha256: observed.sha256 ?? null }] };
  fs.writeFile(join(folder, 'recovery.json'), JSON.stringify(summary) + '\n', { flag: 'wx', mode: 0o600 });
  return summary;
}

/** Quarantine only positively conflicting markers and provably stale locks before choosing the write transport. */
export async function repairGitSync(root, board, io = {}) {
  const { marker } = gitSyncFiles(root);
  const state = gitSyncCompatibility(root, board);
  const observed = readGitSyncMarker(root);
  const owner = inspectGitSyncLock(marker);
  const foreign = observed.exists && (!observed.valid || state.relayHistory);
  const stale = ['dead', 'expired'].includes(owner.state);
  if (!foreign && !stale) return [];
  // A corrupted opt-in must never turn an established Git board into an unrelated local writer.
  if (foreign && state.prefix) throw new Refused('GIT_SYNC_LOCAL_CHANGED',
    'the Git marker conflicts with an established Git prefix; that prefix and pending intent were preserved',
    'restore the explicit Git opt-in before writing; do not create a second move order');
  const summaries = [];
  const recoveryIo = { ...io, onQuarantine: summary => { summaries.push(summary); } };
  /** Recheck under the repair capability: an explicit concurrent opt-in is never mistaken for the original file. */
  const recoverMarker = lease => {
    if (!foreign) return;
    const current = readGitSyncMarker(root);
    const currentState = gitSyncCompatibility(root, board);
    if (!current.exists || current.valid && !currentState.relayHistory) return;
    const summary = quarantineMarker(root, current, owner, lease);
    if (summary) summaries.push(summary);
  };
  // A conflicting marker does not authorize stealing an unknown live legacy lock. Its separate
  // repair lease removes only the foreign marker; ordinary writes then use the existing transport.
  await withGitSyncLock(stale ? marker : marker + '.repair', recoverMarker, recoveryIo);
  for (const summary of summaries) io.err?.('pullboard health: Git sync recovery ' + JSON.stringify(summary));
  return summaries;
}

/** Read bounded recovery summaries, never quarantined marker contents or pending user moves. */
export function readGitSyncRepairs(root) {
  const { quarantine } = gitSyncFiles(root);
  let names;
  try { names = fs.list(quarantine).filter(name => /^git-sync-[A-Za-z0-9-]+$/u.test(name)).sort().slice(-100); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => {
    try {
      const path = join(quarantine, name, 'recovery.json'), stat = fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return [];
      const row = JSON.parse(fs.readFile(path, 'utf8'));
      return row?.version === 1 && typeof row.at === 'string' && Array.isArray(row.artifacts) ? [row] : [];
    } catch { return []; /* Interrupted evidence publication cannot stop the health reader. */ }
  });
}
