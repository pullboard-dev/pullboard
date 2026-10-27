/** Key-free local outbox reads shared by transport and offline status [C7,H5]. */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { readRelayLink } from './relay-link-read.js';

/** The sealed outbox beside a link file. */
export function outboxFile(linkFile) {
  return join(dirname(linkFile), 'relay-outbox.sealed');
}

/** The key-free summary of the outbox beside a link file. */
export function outboxSummaryFile(linkFile) {
  return join(dirname(linkFile), 'relay-outbox.summary.json');
}

/** Read the independently saved summary, or null when it contains no queued moves. */
export function readOutboxSummary(linkFile) {
  try {
    const summary = JSON.parse(readFileSync(outboxSummaryFile(linkFile), 'utf8'));
    return Array.isArray(summary?.moves) && summary.moves.length ? summary : null;
  } catch { return null; }
}

/** Match link loading's summary precedence and legacy sealed-outbox fallback without opening the board. */
export function readOutboxCount(linkFile) {
  const state = readRelayLink(linkFile);
  if (!state || state.unlinking) return 0;
  const waiting = readOutboxSummary(linkFile);
  if (!waiting && !existsSync(outboxFile(linkFile))) return 0;
  const moves = (waiting ?? state.outbox)?.moves;
  return Array.isArray(moves) ? moves.length : 0;
}
