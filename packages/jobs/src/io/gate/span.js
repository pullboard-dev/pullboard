/**
 * The machine's gate span files: one JSON line per phase of a queued submit gate, in a file per UTC day beside the
 * board [C7]. The jobs cell keeps them with the gate jobs whose phases they time.
 *
 * Why a daily file, not the hand-off folder: finished hand-off folders are pruned 30 minutes after they end, and
 * `pullboard gate-health` reads hours of gates in well under a second by opening only the days in its window.
 */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();


/** How long a daily span file is kept; a new day's first span removes older ones. */
const GATE_SPAN_KEEP_DAYS = 14;

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

/**
 * The folder holding the machine's daily span files.
 *
 * @param {string} commonDir - The repository's common Git directory.
 * @returns {string}
 */
export function gateSpanFolder(commonDir) {
  return join(commonDir, 'pullboard', 'gate-spans');
}

/** The UTC day a time falls on, as the span file name's stem. */
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Append one span line to the day file of its end, removing files older than the kept days when that day's file
 * is new. A failed write throws to the caller.
 *
 * @param {string} folder
 * @param {{ end: string }} line - A whole span, as JSON-ready fields.
 */
export function appendGateSpan(folder, line) {
  const end = Date.parse(line.end);
  fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, dayOf(end) + '.jsonl');
  const fresh = !fs.exists(file);
  fs.appendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 });
  if (!fresh) return;
  const oldest = dayOf(end - GATE_SPAN_KEEP_DAYS * 86_400_000);
  for (const name of fs.list(folder)) if (DAY_FILE.test(name) && name.slice(0, 10) < oldest) fs.rm(join(folder, name), { force: true });
}

/**
 * Read the spans that ended at or after `since`, from the day files that can hold them. A line that is not a whole
 * span is skipped.
 *
 * @param {string} folder
 * @param {{ since: number, now?: number }} window
 * @returns {object[]}
 */
export function readGateSpans(folder, { since, now = Date.now() }) {
  if (!fs.exists(folder)) return [];
  const first = dayOf(since);
  const last = dayOf(now);
  const spans = [];
  for (const name of fs.list(folder).sort()) {
    if (!DAY_FILE.test(name) || name.slice(0, 10) < first || name.slice(0, 10) > last) continue;
    for (const text of fs.readFile(join(folder, name), 'utf8').split('\n')) {
      if (!text) continue;
      let span;
      try { span = JSON.parse(text); } catch { continue; /* a torn line is skipped */ }
      if (span?.v === 1 && typeof span.job === 'string' && typeof span.phase === 'string' && Date.parse(span.end) >= since) spans.push(span);
    }
  }
  return spans;
}
