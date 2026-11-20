/** Replay pull claims against a copy of a board's database to measure what one claim costs at that board's size [C7,#12097]. */
import { DatabaseSync } from 'node:sqlite';
import { fileSystemAdapter } from '../../../fs/index.js';
import { boardJobQueueCall } from './gate.js';

const fs = fileSystemAdapter();

/** The value at a fraction of the sorted samples, the nearest rank. */
function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

/**
 * Run `count` pull claims through boardJobQueueCall on a copy of the board database, each inside a transaction that is
 * rolled back, and report how long they took. Why a copy: the claim path writes, and the live board must never be written by a measurement.
 *
 * @param {{ db: string, root: string, count?: number }} options - db: the board database file; root: the board's repository root.
 * @returns {{ p50: number, p95: number, max: number }} Milliseconds per claim.
 */
export function replayClaims({ db, root, count = 50 }) {
  const copyFile = `${db}.replay-${process.pid}`;
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
