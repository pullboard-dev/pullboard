/** The append-only stats history file: dated checkpoints are added, never rewritten [R1,C7]. */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
