/** Landing failures are ordinary health notices, with explicit coordinator acknowledgement [B3,R3,A6,C7]. */
import { landingBatches } from '../../../git/index.js';

const ESCALATE_MS = 15 * 60_000;
const CAUSE = 'LAND_BATCH_REFUSED';

/** A coordinator's explicit batch acknowledgement is an ordinary native note, never a read receipt. */
function acknowledgements(board) {
  const acknowledged = new Map();
  const rows = board.db.prepare("SELECT * FROM event WHERE event_kind='fact' AND event_by='coordinator' ORDER BY event_id").all();
  for (const event of rows) {
    const detail = JSON.parse(event.event_detail);
    const batch = detail.kind === 'note' && /^Landing batch ([A-Za-z0-9_-]{1,80}): acknowledged(?:\b|$)/u.exec(detail.text ?? '')?.[1];
    if (!batch) continue;
    const entries = acknowledged.get(batch) ?? [];
    entries.push({ at: Date.parse(event.event_at), item: event.item_id });
    acknowledged.set(batch, entries);
  }
  return acknowledged;
}

/** An item is settled when it has a recorded merged commit or is withdrawn, however it landed; an unknown id is not settled. */
function settled(board, id) {
  const row = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(id);
  return Boolean(row && (row.item_status === 'withdrawn' || row.item_merged_commit));
}

/** Project only the newest batch for an item; a later attempt or landing retires its old failure. */
export function landingFailureFindings(board, now = board.clock.now()) {
  const at = now.getTime(), ack = acknowledgements(board), seen = new Set(), findings = [];
  for (const batch of [...landingBatches(board)].reverse().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))) {
    const ids = [...new Set([...(batch.items ?? []), ...(batch.candidates ?? []), ...(batch.culprits ?? []),
      ...(batch.conflicts ?? []), ...(batch.blocked ?? [])].map(entry => entry.id).filter(Number.isSafeInteger))];
    const affected = ids.filter(id => !seen.has(id));
    for (const id of ids) seen.add(id);
    if (ids.length && ids.every(id => settled(board, id))) continue;
    if (!affected.length || batch.state === 'landed' || batch.supersededByMain
      || !batch.refusal && !['blocked', 'flaky', 'test-defect'].includes(batch.state)) continue;
    const since = batch.refusal?.at ?? batch.updatedAt;
    const start = Date.parse(since);
    if (!Number.isFinite(start)) continue;
    const raw = batch.refusal?.code ?? ((batch.failures?.length || batch.culprits?.length) ? 'LAND_GATE_RED' : 'LAND_BATCH_BLOCKED');
    const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(raw) ? raw : 'LAND_BATCH_REFUSED';
    const answered = (ack.get(batch.id) ?? []).some(entry => entry.at >= start && ids.includes(entry.item));
    const escalated = at - start >= ESCALATE_MS && !answered;
    findings.push({ key: CAUSE + ':' + batch.id, cause: CAUSE, item: affected[0],
      subject: affected.slice(0, 4).map(id => '#' + id).join(', '), title: 'landing refused: ' + code,
      since, ageMs: Math.max(0, at - start), why: 'Landing batch ' + batch.id + ': inspect its recorded refusal ' + code,
      next: `inspect pullboard resume; acknowledge with pullboard fact ${affected[0]} note \"Landing batch ${batch.id}: acknowledged\"`,
      owner: { role: escalated ? 'person' : 'coordinator', who: escalated ? 'person' : 'coordinator' } });
  }
  return findings;
}

/** Append landing observations to the last health snapshot without clearing unrelated findings. */
export function landingFailureObservation(board) {
  board.db.exec('SAVEPOINT landing_failure_observation');
  try {
    const row = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='health-scan' ORDER BY event_id DESC LIMIT 1").get();
    const active = row ? JSON.parse(row.event_detail).active ?? [] : [];
    const current = landingFailureFindings(board);
    /** Compare the same ownership episode without its presentation-only fields. */
    const identity = finding => JSON.stringify([finding.key, finding.since, finding.owner?.who ?? finding.owner]);
    const previous = active.filter(finding => finding.cause === CAUSE).map(identity).sort();
    if (JSON.stringify(previous) === JSON.stringify(current.map(identity).sort())) return null;
    const findings = [...current, ...active.filter(finding => finding.cause !== CAUSE)
      .map(finding => ({ ...finding, owner: { who: finding.owner } }))];
    return { observedRevision: board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n, findings };
  } finally { board.db.exec('RELEASE landing_failure_observation'); }
}
