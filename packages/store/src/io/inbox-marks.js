/** The spool behind inbox.batchedMarks: queued delivery marks outlive the command that read the inbox [C7,#8942]. */
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** The spool file beside the board: one JSON line per queued mark or delivery. */
export const spoolFile = boardFile => join(dirname(boardFile), 'pullboard-inbox-marks.jsonl');

/**
 * Append queued entries to the spool, one line each.
 * Why: the store queue is memory only and a command exits right after its read; the worker is another process (#9117).
 *
 * An entry is `[agent, mark]` (the highest shout id the agent was shown) or `{ agent, delivery }`, where delivery is the
 * exact argument object recordActivityDelivery takes after its agentId: `{ interrupts, through, observedThrough, digestThrough? }` (#10878).
 *
 * @param {string} boardFile
 * @param {([string, number] | { agent: string, delivery: object })[]} entries
 */
export function spoolInboxMarks(boardFile, entries) {
  if (!entries.length) return;
  const line = entry => JSON.stringify(Array.isArray(entry) ? { agent: entry[0], mark: entry[1] } : { agent: entry.agent, delivery: entry.delivery });
  appendFileSync(spoolFile(boardFile), entries.map(line).join('\n') + '\n', { mode: 0o600 });
}

/**
 * Write every spooled mark in one batch through the caller's board ports, record every spooled delivery in spool order,
 * then delete what was written.
 *
 * The spool is renamed first, so entries spooled while this runs go to a fresh file for the next pass; a work file a
 * crashed worker left behind is read too. A mark write is `MAX(recorded, mark)` and a delivery never lowers a recorded
 * cursor, so replaying either is harmless. Without a `recordDelivery` port, delivery lines stay in their work file for a
 * later drain that has one.
 *
 * @param {string} boardFile
 * @param {{ enqueue: (agent: string, mark: number) => void, flush: () => number, recordDelivery?: (agent: string, delivery: object) => void }} ports - the board's queue, its one batched write and its delivery record
 * @returns {number} how many agents' marks were written
 */
export function drainInboxMarks(boardFile, { enqueue, flush, recordDelivery }) {
  const spool = spoolFile(boardFile);
  const dir = dirname(spool), prefix = `${basename(spool)}.work-`;
  if (existsSync(spool)) { try { renameSync(spool, join(dir, `${prefix}${process.pid}`)); } catch { /* Another worker took it. */ } }
  const taken = readdirSync(dir).filter(name => name.startsWith(prefix)).sort().map(name => join(dir, name));
  const deliveries = new Map();
  for (const file of taken) {
    const lines = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry?.agent !== 'string') continue;
      if (Number.isSafeInteger(entry.mark) && entry.mark >= 0) enqueue(entry.agent, entry.mark);
      else if (entry.delivery && typeof entry.delivery === 'object') lines.push(entry);
    }
    deliveries.set(file, lines);
  }
  const written = flush();
  for (const [file, lines] of deliveries) {
    if (recordDelivery) for (const { agent, delivery } of lines) recordDelivery(agent, delivery);
    if (recordDelivery || !lines.length) rmSync(file, { force: true });
    else writeFileSync(file, lines.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  }
  return written;
}
