/** The append-only stats history file: dated checkpoints are added, never rewritten [R1,C7]. */
import { dirname } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** The time checkpoint log's file name under the board's private folder; this module appends to it, so it owns the store [R1,C7]. */
export const STATS_HISTORY_FILE = 'stats-history.jsonl';

/** The history file's path is built in one place; this writer re-exports it so callers name one module [C7]. */
export { statsHistoryFile } from './history/path.js';

/**
 * Read the history text, empty when nothing has been recorded yet.
 *
 * @param {string} file
 * @returns {string}
 */
export function readTimeHistory(file) {
  try { return fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

/**
 * Append one checkpoint line.
 *
 * @param {string} file
 * @param {string} line
 */
export function appendTimeCheckpoint(file, line) {
  fs.mkdir(dirname(file), { recursive: true });
  fs.appendFile(file, `${line}\n`);
}
