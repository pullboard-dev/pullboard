/** A main-moved notice that failed is kept in a repository log and replayed at the start of the next landing wake [C7]. */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { publishStateFile } from '../pause.js';
import { refreshLandedCodeMap } from '../../logic/main/notices.js';

/**
 * The repository's log of notices still to deliver, shared by every worktree.
 *
 * @param {string} root - Any checkout of the repository.
 * @returns {string}
 */
export function deferredNoticesFile(root) {
  return join(dirname(publishStateFile(root)), 'deferred-notices.jsonl');
}

/**
 * Append one pending notice to the log, stamped with the time it was deferred.
 *
 * @param {string} root
 * @param {{ kind: string, main: string }} entry - What the core returned for the failed notice.
 * @param {string} [at] - The time to record, replaceable in tests.
 * @returns {{ kind: string, main: string, at: string }} The line written.
 */
export function appendDeferredNotice(root, entry, at = new Date().toISOString()) {
  const file = deferredNoticesFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const line = { kind: entry.kind, main: entry.main, at };
  appendFileSync(file, JSON.stringify(line) + '\n');
  return line;
}

/**
 * The pending notices in the order they were deferred; a line that is not a notice is skipped.
 *
 * @param {string} root
 * @returns {{ kind: string, main: string, at: string }[]}
 */
export function readDeferredNotices(root) {
  let text;
  try { text = readFileSync(deferredNoticesFile(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = [];
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.kind === 'string' && typeof entry.main === 'string') entries.push(entry);
    } catch { /* a torn or foreign line holds no notice */ }
  }
  return entries;
}

/**
 * Replay the pending notices in order and drop each that succeeds; one that fails stays for the next wake.
 * Why: a failed warnMainMoved was only logged as deferred, so seats could miss a stale-verdict notice for good [C7].
 *
 * @param {{ root: string, say: Function }} state
 * @param {(trunk: string) => Promise<unknown>} warn - Sends the main-moved notice for one main commit; throws when it cannot.
 * @returns {Promise<{ replayed: number, kept: number }>}
 */
export async function replayDeferredNotices({ root, say }, warn) {
  const pending = readDeferredNotices(root);
  if (!pending.length) return { replayed: 0, kept: 0 };
  const kept = [];
  for (const entry of pending) {
    if (entry.kind !== 'main-moved') { kept.push(entry); continue; }
    try { await warn(entry.main); }
    catch (error) {
      say(`main-move notice for ${entry.main.slice(0, 12)} still deferred: ${error.message}`);
      kept.push(entry);
    }
  }
  const file = deferredNoticesFile(root);
  if (!kept.length) rmSync(file, { force: true });
  else {
    const draft = `${file}.tmp`;
    writeFileSync(draft, kept.map(entry => JSON.stringify(entry) + '\n').join(''));
    renameSync(draft, file);
  }
  return { replayed: pending.length - kept.length, kept: kept.length };
}

/**
 * Refresh the landed main's derived views, keeping any notice that failed so the next landing wake retries it.
 *
 * @param {object} state - The landing state refreshLandedCodeMap reads.
 * @returns {Promise<void>}
 */
export async function refreshLandedMain(state) {
  const { deferred } = await refreshLandedCodeMap(state);
  for (const entry of deferred) appendDeferredNotice(state.root, entry);
}
