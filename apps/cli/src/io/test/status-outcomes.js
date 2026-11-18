/** A finished test run's per-case outcomes for `pullboard test --status --json`, behind test.statusOutcomes [C7,#9085]. */
import { closeSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readSync } from 'node:fs';
import { allTestOutcomes } from '../../../../../packages/gate/light.js';

/** The most of a log's end that is read: the outcome frames sit at the end, so a long log is never read whole. */
const READ_BYTES = 4 * 1024 * 1024;

/**
 * The `{ file, name, passed, skipped }` rows of every outcome frame in a run's log, in order. The log keeps only its last
 * 40 KB, so a big run loses its `ok N - ...` lines; the framed outcome lines are written last and survive. A frame cut by the
 * log's start is skipped. Null when the log cannot be read, so a reader tells that from a run with no cases.
 *
 * @param {string} path - The run's log file.
 * @returns {{ file: string, name: string, passed: boolean, skipped: boolean }[] | null}
 */
export function statusOutcomes(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size, length = Math.min(size, READ_BYTES), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return allTestOutcomes(buffer.toString('utf8')).map(({ file, name, passed, skipped }) => ({ file, name, passed, skipped }));
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
