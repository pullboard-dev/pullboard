/** The append-only stats history file: dated checkpoints are added, never rewritten [R1,C7]. */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The time checkpoint log's file name under the board's private folder; this module appends to it, so it owns the store [R1,C7]. */
export const STATS_HISTORY_FILE = 'stats-history.jsonl';

/**
 * Read the history text, empty when nothing has been recorded yet.
 *
 * @param {string} file
 * @returns {string}
 */
export function readTimeHistory(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

/**
 * Append one checkpoint line.
 *
 * @param {string} file
 * @param {string} line
 */
export function appendTimeCheckpoint(file, line) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`);
}
