/** Replay pull claims against a copy of a board's database to measure what one claim costs at that board's size [C7,#12097]. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileSystemAdapter } from '../../../fs/index.js';
import { boardJobQueueCall } from './gate.js';

const fs = fileSystemAdapter();

/** Free bytes of the volume holding `dir`. */
function defaultFreeBytes(dir) {
  const info = fs.statfs(dir);
  return info.bavail * info.bsize;
}

/** The value at a fraction of the sorted samples, the nearest rank. */
function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

/**
 * Run `count` pull claims through boardJobQueueCall on a copy of the board database, each inside a transaction that is
 * rolled back, and report how long they took. Why a copy: the claim path writes, and the live board must never be written by a measurement.
 *
 * The copy goes to a uniquely named file in os.tmpdir(), never beside the source, and only when the free space there is at
 * least twice the source's size; otherwise this throws before anything is written.
 *
 * @param {{ db: string, root: string, count?: number, freeBytes?: (dir: string) => number }} options - db: the board database file; root: the board's repository root; freeBytes: reads the free bytes of a directory (injected so a test needs no full disk).
 * @returns {{ p50: number, p95: number, max: number }} Milliseconds per claim.
 */
export function replayClaims({ db, root, count = 50, freeBytes = defaultFreeBytes }) {
  const scratch = tmpdir();
  const sourceSize = fs.stat(db).size;
  const free = freeBytes(scratch);
  if (free < sourceSize * 2) throw new Error(`claim replay needs ${sourceSize * 2} free bytes in ${scratch} and ${free} are free`);
  const copyFile = join(scratch, `pullboard-claim-replay-${process.pid}-${Date.now()}.db`);
  const source = new DatabaseSync(db, { readOnly: true });
  try { source.prepare('VACUUM INTO ?').run(copyFile); } finally { source.close(); }
  const copy = new DatabaseSync(copyFile);
  const board = { db: copy, gitRoot: root, root };
  const took = [];
  try {
    for (let index = 0; index < count; index++) {
      copy.exec('BEGIN IMMEDIATE');
      const started = performance.now();
      try {
        boardJobQueueCall(board, { action: 'claim', runner: `claim-replay-${index}`, capabilities: [] }, { mode: 'pull' });
      } finally {
        took.push(performance.now() - started);
        copy.exec('ROLLBACK');
      }
    }
  } finally {
    copy.close();
    fs.rm(copyFile, { force: true });
  }
  const sorted = took.toSorted((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) };
}

/** The one line the command prints: the three figures for a replay. */
export function replayLine({ p50, p95, max }, count) {
  return `claim replay: ${count} claims p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`;
}
