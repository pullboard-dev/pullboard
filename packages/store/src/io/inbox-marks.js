/** The spool behind inbox.batchedMarks: queued delivery marks outlive the command that read the inbox [C7,#8942]. */
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** The spool file beside the board: one JSON line per queued mark. */
export const spoolFile = boardFile => join(dirname(boardFile), 'pullboard-inbox-marks.jsonl');

/**
 * Append queued marks to the spool, one line each.
 * Why: the store queue is memory only and a command exits right after its read; the worker is another process (#9117).
 *
 * @param {string} boardFile
 * @param {[string, number][]} entries - agent id and the highest shout id it was shown
 */
export function spoolInboxMarks(boardFile, entries) {
  if (!entries.length) return;
  appendFileSync(spoolFile(boardFile), entries.map(([agent, mark]) => JSON.stringify({ agent, mark })).join('\n') + '\n', { mode: 0o600 });
}

/**
 * Write every spooled mark in one batch through the caller's board ports, then delete what was written.
 *
 * The spool is renamed first, so marks spooled while this runs go to a fresh file for the next pass; a work file a
 * crashed worker left behind is read too. A write is `MAX(recorded, mark)`, so replaying one is harmless.
 *
 * @param {string} boardFile
 * @param {{ enqueue: (agent: string, mark: number) => void, flush: () => number }} ports - the board's queue and its one batched write
 * @returns {number} how many agents' marks were written
 */
export function drainInboxMarks(boardFile, { enqueue, flush }) {
  const spool = spoolFile(boardFile);
  const dir = dirname(spool), prefix = `${basename(spool)}.work-`;
  if (existsSync(spool)) { try { renameSync(spool, join(dir, `${prefix}${process.pid}`)); } catch { /* Another worker took it. */ } }
  const taken = readdirSync(dir).filter(name => name.startsWith(prefix)).map(name => join(dir, name));
  for (const file of taken) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry?.agent === 'string' && Number.isSafeInteger(entry.mark) && entry.mark >= 0) enqueue(entry.agent, entry.mark);
    }
  }
  const written = flush();
  for (const file of taken) rmSync(file, { force: true });
  return written;
}
