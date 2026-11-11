/** Read distinct duration evidence without equating timing logs with proof of full coverage [C7,D3]. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readGateReceipt } from '../../../packages/gate/index.js';
import { eventRows } from './events.js';

/** Return an explicit sample summary, preserving a missing population as null. */
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { n, medianMs: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null,
    p95Ms: n ? sorted[Math.ceil(n * 0.95) - 1] : null };
}

/** Retain the exact supplied historical log table's population, including failed or incomplete runs. */
export function suiteLogMetrics(file) {
  const bytes = readFileSync(file), lines = bytes.toString('utf8').trimEnd().split('\n');
  if (lines.shift() !== 'file\tmtime_utc\tpass\tfail\tduration_ms') throw new TypeError('restore the full-suite log table with its exact five-column header');
  const seen = new Set(), times = [], durations = [];
  let zeroFailureSummaries = 0, failingSummaries = 0;
  for (const line of lines) {
    const fields = line.split('\t');
    const [name, at, passed, failed, duration] = fields;
    if (fields.length !== 5 || !name || seen.has(name) || !Number.isFinite(Date.parse(at))
      || !/^\d+$/u.test(passed) || !/^\d+$/u.test(failed) || !Number.isFinite(Number(duration)) || Number(duration) <= 0) {
      throw new TypeError('restore a unique, timestamped, positive-duration full-suite log observation');
    }
    seen.add(name); times.push(Date.parse(at)); durations.push(Number(duration));
    if (Number(failed) === 0) zeroFailureSummaries++;
    else failingSummaries++;
  }
  return { ...summary(durations), sourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    window: { from: times.length ? new Date(Math.min(...times)).toISOString() : null,
      to: times.length ? new Date(Math.max(...times)).toISOString() : null, basis: 'source file modification timestamps' },
    zeroFailureSummaries, failingSummaries,
    population: 'one extracted TAP duration per unique coordinator-supplied historical full-suite-labelled log file',
    qualification: 'Historical log observations, including failed or possibly incomplete collections; filenames and zero failures do not prove full coverage, source identity, or a current green suite. This separate population is not the board-event observation window.' };
}

/** Recover frozen-command durations only when canonical native receipts match the exact retained criterion. */
export function frozenCheckMetrics(boardPath, { from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new TypeError('frozen duration metrics require valid from < to timestamps');
  const db = new DatabaseSync(boardPath, { readOnly: true }), values = [], receipts = new Map();
  let candidates = 0, unknown = 0, conflictingIds = 0;
  try {
    db.exec('BEGIN');
    const hasItems = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='item'").get();
    const items = hasItems ? new Map(db.prepare('SELECT item_id,item_frozen,item_frozen_digest FROM item').all().map(row => [row.item_id, row])) : new Map();
    for (const event of eventRows(db, 'proof-run')) {
      let flat;
      try { flat = JSON.parse(event.event_detail).receipt; } catch { continue; }
      if (typeof flat?.id !== 'string' || !flat.id) continue;
      const signature = createHash('sha256').update(JSON.stringify(flat)).digest('hex');
      const at = Date.parse(flat.at);
      const candidate = flat.kind === 'submit' && Number.isFinite(at) && at > start && at <= end;
      const previous = receipts.get(flat.id);
      if (previous) {
        previous.conflict ||= previous.signature !== signature || previous.itemId !== event.item_id;
        if (candidate && !previous.candidate) {
          previous.candidate = true;
          previous.flat = durationBinding(flat);
          previous.candidateItemId = event.item_id;
        }
      } else {
        receipts.set(flat.id, { signature, itemId: event.item_id, conflict: false, candidate,
          ...(candidate ? { flat: durationBinding(flat), candidateItemId: event.item_id } : {}) });
      }
    }
    for (const [id, observed] of receipts) {
      if (!observed.candidate) continue;
      candidates++;
      if (observed.conflict) { unknown++; conflictingIds++; continue; }
      const flat = observed.flat, itemId = observed.candidateItemId;
      const item = items.get(itemId), receipt = readGateReceipt(join(dirname(boardPath), 'gate-receipts'), id);
      let frozen;
      try { frozen = JSON.parse(item?.item_frozen); } catch { unknown++; continue; }
      const command = typeof frozen?.check === 'string' ? createHash('sha256').update(frozen.check).digest('hex') : null;
      const proof = receipt?.proof;
      if (!receipt || receipt.version !== 2 || receipt.kind !== 'submit' || receipt.command !== command
        || item.item_frozen_digest !== flat.frozenDigest || proof?.frozenDigest !== flat.frozenDigest
        || proof?.item !== itemId || flat.item !== itemId
        || receipt.head !== flat.commit || receipt.tree !== flat.tree || receipt.at !== flat.at
        || proof?.sourceClean !== true || proof.durationMs !== flat.durationMs
        || !Number.isFinite(proof.durationMs) || proof.durationMs <= 0) { unknown++; continue; }
      values.push(proof.durationMs);
    }
    db.exec('ROLLBACK');
  } finally { db.close(); }
  return { ...summary(values), candidates, unknown, conflictingIds,
    population: 'globally consistent unique submit receipt IDs in (from,to] that also bind a canonical v2 receipt, source head/tree, current retained frozen digest and exact frozen command SHA256',
    qualification: 'Recorded frozen-command durationMs, not controller wall time or inherited timing receipt runMs. Historical criteria replaced by refreezes are unknown. Includes green and red attempts; canonical receipt files are required and no total/full-suite duration is inferred.' };
}

/** Retain only canonical binding fields after hashing the complete native receipt payload. */
function durationBinding(flat) {
  return { at: flat.at, frozenDigest: flat.frozenDigest, item: flat.item,
    commit: flat.commit, tree: flat.tree, durationMs: flat.durationMs };
}
