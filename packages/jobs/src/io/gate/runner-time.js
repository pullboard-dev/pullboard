/**
 * The machine's runner-time files: one JSON line per runner dispatch, a file per UTC day beside the gate spans [C7,#8183].
 * Why a file of its own: the runner worker imports the gate span file, and this reader is for the controller side and
 * `pullboard gate-health`, so it stays out of the worker's bundle.
 */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();


const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

/**
 * The folder holding the machine's daily runner-time files, a sibling of the gate spans.
 *
 * @param {string} commonDir - The repository's common Git directory.
 * @returns {string}
 */
export function runnerTimeFolder(commonDir) {
  return join(commonDir, 'pullboard', 'runner-time');
}

/**
 * Read the runner dispatches that ended at or after `since`, from the day files that can hold them. A line that is not
 * a whole record (host, item, kind and minutes) is skipped.
 *
 * @param {string} folder
 * @param {{ since: number, now?: number }} window
 * @returns {{ v: 1, host: string, item: string, kind: string, minutes: number, start: string, end: string, outcome: string }[]}
 */
export function readRunnerTime(folder, { since, now = Date.now() }) {
  if (!fs.exists(folder)) return [];
  const first = new Date(since).toISOString().slice(0, 10), last = new Date(now).toISOString().slice(0, 10);
  const lines = [];
  for (const name of fs.list(folder).sort()) {
    if (!DAY_FILE.test(name) || name.slice(0, 10) < first || name.slice(0, 10) > last) continue;
    for (const text of fs.readFile(join(folder, name), 'utf8').split('\n')) {
      if (!text) continue;
      let line;
      try { line = JSON.parse(text); } catch { continue; /* a torn line is skipped */ }
      if (line?.v === 1 && typeof line.host === 'string' && typeof line.item === 'string' && typeof line.kind === 'string'
        && Number.isFinite(line.minutes) && line.minutes >= 0 && Date.parse(line.end) >= since) lines.push(line);
    }
  }
  return lines;
}
