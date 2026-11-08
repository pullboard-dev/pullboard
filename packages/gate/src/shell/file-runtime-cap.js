/** Read per-file runtimes from gate receipts and decide the two-minute cap for a candidate's files [C7]. */
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileRuntimeCapReport } from '../core/file-runtime-cap.js';
import { fileRuntimeCapFailure } from '../core/file-runtime-cap.js';
import { readTestValueTimings } from './test-value-timing.js';
import { receiptStore } from './gate-run-receipt.js';

/** The newest measured wall time per file across every receipt sidecar in a gate receipt store. */
export function receiptFileRuntimes(store) {
  const newest = new Map();
  let names = [];
  try { names = readdirSync(join(store, 'test-value')); } catch { return {}; }
  for (const name of names) {
    const id = name.replace(/\.json$/u, '');
    const timings = readTestValueTimings(store, id);
    if (!timings) continue;
    let at = 0;
    try { at = statSync(join(store, 'test-value', name)).mtimeMs; } catch { continue; }
    for (const row of timings.files) {
      const seen = newest.get(row.file);
      if (!seen || at >= seen.at) newest.set(row.file, { at, durationMs: row.durationMs });
    }
  }
  return Object.fromEntries([...newest].map(([file, row]) => [file, row.durationMs]));
}

/** The newest receipt runtime per file for the repository a checkout belongs to; none when it keeps no receipts. */
export function rootReceiptRuntimes(root) {
  const store = receiptStore(root);
  return store ? receiptFileRuntimes(store) : {};
}

/** List every file whose last receipt runtime is over the cap, slowest first, for the coordinator to file split items. */
export function filesOverRuntimeCap(store) {
  return fileRuntimeCapReport({}, receiptFileRuntimes(store)).over;
}

/** Top-level cases of one finished file with their measured times, as split-seam candidates. */
export function topLevelCaseTimes(events) {
  return events.filter(event => (event.type === 'test:pass' || event.type === 'test:fail') && event.data.nesting === 0
    && Number.isFinite(event.data.details?.duration_ms)).map(event => ({ name: event.data.name, durationMs: event.data.details.duration_ms }));
}

/** The refusal message for one file just run against its last known runtime, or null when it stays within the cap. */
export function fileRuntimeCapRefusal(file, durationMs, history, events, cap) {
  return fileRuntimeCapFailure(file, durationMs, history[file], topLevelCaseTimes(events), cap);
}
