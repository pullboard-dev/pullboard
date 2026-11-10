/** Landing replay: what the current decision code does with recorded batches, read from the board alone [C7]. */
import { bisectableFailures } from './step/failures.js';
import { unwaivedFailures } from './step/failures.js';

/**
 * Decide one recorded batch from its own record: items, gate receipts and any recorded main comparison.
 * Why: every lander fix was proven only by the next live batch, 10 to 30 minutes later; this reads the record instead
 * and starts no test run, git merge or runner job. A comparison that was never recorded is marked, not guessed.
 */
export function replayBatch(batch, landingPorts = {}) {
  const evidence = batch.invariantEvidence;
  const gates = Array.isArray(evidence?.gates) ? evidence.gates : [];
  const items = (batch.items ?? []).map(entry => entry.id);
  const base = { batch: batch.id, state: batch.state, items };
  if (!gates.length) return { ...base, decision: 'hold', stop: 'no gate result is recorded for this batch' };
  const last = gates.at(-1);
  if (last.isGreen) return { ...base, decision: 'land', stop: null };
  const known = new Set(Array.isArray(batch.knownMain) ? batch.knownMain.map(entry => entry.file ?? entry) : []);
  const failures = (last.failures ?? []).map(file => ({ file, name: file }));
  const own = unwaivedFailures(null, failures, landingPorts).filter(failure => !known.has(failure.file));
  if (failures.length && !own.length && known.size) return { ...base, decision: 'set aside known-main', files: failures.map(failure => failure.file), stop: null };
  if (!failures.length) return { ...base, decision: 'hold', stop: 'the red gate names no failing file' };
  if (!known.size && !Array.isArray(batch.knownMain)) {
    const named = bisectableFailures(null, failures, landingPorts);
    if (!named) return { ...base, decision: 'hold', stop: 'a red gate with no file to bisect on', comparison: 'would be needed' };
    return { ...base, decision: 'bisect to culprits', files: named.map(failure => failure.file), culprits: last.submissions?.map(row => row.id) ?? [], comparison: 'would be needed' };
  }
  const named = bisectableFailures(null, own, landingPorts);
  return named ? { ...base, decision: 'bisect to culprits', files: named.map(failure => failure.file), culprits: last.submissions?.map(row => row.id) ?? [] }
    : { ...base, decision: 'hold', stop: 'no failing file can be bisected on' };
}

/** Replay the latest record of every landing batch, optionally only those updated since a time; the board is only read. */
export function replayLanding(board, { since } = {}) {
  const cutoff = since === undefined ? 0 : Date.parse(since);
  if (since !== undefined && !Number.isFinite(cutoff)) throw Object.assign(new Error('--since needs a time such as 2026-11-04T00:00:00Z'), { code: 'USAGE' });
  const latest = new Map();
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'landing_batch' ORDER BY event_id").all()) {
    const { batch } = JSON.parse(row.event_detail);
    latest.set(batch.id, batch);
  }
  return [...latest.values()].filter(batch => !cutoff || Date.parse(batch.updatedAt ?? batch.startedAt ?? 0) >= cutoff).map(batch => replayBatch(batch));
}

/** One line per replayed batch. */
export function replayLine(row) {
  const detail = [row.files?.length ? row.files.join(', ') : null, row.culprits?.length ? `items ${row.culprits.map(id => `#${id}`).join(', ')}` : null,
    row.stop, row.comparison ? `comparison ${row.comparison}` : null].filter(Boolean).join('; ');
  return `${row.batch} [${row.state}] ${row.decision}${detail ? `: ${detail}` : ''}`;
}
