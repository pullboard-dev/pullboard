/** Canonical interrupt acknowledgements are recipient-owned ordered records, never local cursors [R2,N26,H16]. */
import { Refused } from './refused.js';

/** Address one recipient's indexed derived state without sharing another seat's acknowledgement. */
function prefix(agentId, state) { return `activity:${agentId}:${state}:`; }

/** Read one derived record; malformed native state is not a successful acknowledgement. */
function value(board, key) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Preserve the immutable source log while updating its per-recipient delivery projection. */
function save(board, key, data) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(key, JSON.stringify(data));
}

/** Every receipt belongs to a real joined seat; transport authentication additionally binds the move actor. */
function recipient(board, agentId) {
  if (typeof agentId !== 'string' || !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(agentId)) {
    throw new Refused('NOT_JOINED', 'join your own lane before recording activity delivery');
  }
}

/** Enumerate only pending records through the primary-key range, leaving acted history out of the hot read. */
export function activityDeliveryState(board, agentId) {
  recipient(board, agentId);
  const start = prefix(agentId, 'pending');
  const pending = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
    .all(start, `${start}\uffff`).map(row => JSON.parse(row.meta_value));
  return { ...(value(board, prefix(agentId, 'cursor')) ?? { through: 0, digestThrough: 0 }), pending };
}

/** Resolve a rejection's original recipient from immutable receipts, not the item's later builder. */
export function rejectionRecipient(board, event, detail) {
  if (detail.reopenFirstRefusal?.builder) return detail.reopenFirstRefusal.builder;
  if (typeof detail.commit !== 'string') return null;
  return board.db.prepare(`SELECT event_by FROM event WHERE item_id=? AND event_kind='submit' AND event_id<?
    AND json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END,'$.commit')=?
    ORDER BY event_id DESC LIMIT 1`).get(event.item_id, event.event_id, detail.commit)?.event_by ?? null;
}

/** Validate exact source identities before recording any part of a delivery batch. */
function canonicalInterrupt(board, agentId, input, observedThrough) {
  if (!input || typeof input.id !== 'string' || input.id.length > 256) {
    throw new Refused('BAD_ACTIVITY_RECEIPT', 'read inbox again to obtain an exact interrupt identity');
  }
  if (input.reason === 'claim-lapsing') {
    const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(input.item);
    if (!item || item.item_status !== 'claimed' || item.item_owner !== agentId || item.item_lease_until !== input.leaseUntil
      || input.id !== `claim:${item.item_id}:${item.item_lease_until}`) {
      throw new Refused('STALE_ACTIVITY_RECEIPT', 'the claim changed; read inbox again before recording its delivery');
    }
    return { id: input.id, reason: input.reason, kind: 'claim', item: item.item_id,
      leaseUntil: item.item_lease_until, text: `#${item.item_id} claim lease ${item.item_lease_until} needed attention; acknowledge only after acting` };
  }
  if (!Number.isSafeInteger(input.eventId) || input.eventId < 1 || input.eventId > observedThrough || input.id !== `event:${input.eventId}`) {
    throw new Refused('BAD_ACTIVITY_RECEIPT', 'an interrupt must name an observed native event; read inbox again');
  }
  const event = board.db.prepare('SELECT * FROM event WHERE event_id=?').get(input.eventId);
  const detail = event && JSON.parse(event.event_detail);
  let text;
  if (input.reason === 'rejected' && event?.event_kind === 'reject' && rejectionRecipient(board, event, detail) === agentId) {
    text = `#${event.item_id} was rejected; read its verdict and repair or release it`;
  } else if (input.reason === 'answered' && event?.event_kind === 'answer') {
    const answer = board.db.prepare('SELECT * FROM shout WHERE shout_id=?').get(detail.shout);
    const question = answer && board.db.prepare('SELECT * FROM shout WHERE shout_id=?').get(answer.shout_answers);
    if (question?.shout_from === agentId && question.shout_decision) text = `question #${question.shout_id} was answered; read answer #${answer.shout_id}`;
  } else if (input.reason === 'files-changed' && event?.event_kind === 'main-moved') {
    const files = input.files ?? [];
    if (!Array.isArray(files) || !files.length && input.unknownFiles !== true && input.unknownAdditionalFiles !== true
      || files.some(path => typeof path !== 'string' || !path || path.length > 4096)) {
      throw new Refused('BAD_ACTIVITY_RECEIPT', 'a file interrupt needs its observed Git paths; read inbox again');
    }
    // Paths describe the recipient's Git observation. They grant no board or file authority.
    text = input.unknownFiles || input.unknownAdditionalFiles
      ? 'main changed; some working-file overlap is unknown; inspect the recorded main change'
      : `main changed ${new Set(input.files).size} files you are editing; inspect the recorded main change`;
  }
  if (!text) throw new Refused('BAD_ACTIVITY_RECEIPT', 'that event is not this seat\'s interrupt; read your own inbox');
  return { id: input.id, eventId: event.event_id, at: event.event_at, by: event.event_by,
    reason: input.reason, kind: event.event_kind, ...(event.item_id === null ? {} : { item: event.item_id }),
    ...(input.reason === 'files-changed' ? { files: [...new Set(input.files ?? [])].toSorted(), ...(input.unknownFiles ? { unknownFiles: true } : {}),
      ...(input.unknownAdditionalFiles ? { unknownAdditionalFiles: true } : {}) } : {}), text };
}

/** Record only actually included interrupts, once; withheld and later events stay available. */
export function recordActivityDelivery(board, { agentId, interrupts = [], through, observedThrough = through, digestThrough }, { atomic, logEvent }) {
  return atomic(board, () => {
    recipient(board, agentId);
    const high = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id;
    if (!Number.isSafeInteger(through) || through < 0 || through > high
      || !Number.isSafeInteger(observedThrough) || observedThrough < through || observedThrough > high
      || !Array.isArray(interrupts) || interrupts.length > 1000
      || digestThrough !== undefined && (!Number.isSafeInteger(digestThrough) || digestThrough < 0 || digestThrough > observedThrough)) {
      throw new Refused('BAD_ACTIVITY_RECEIPT', 'delivery must name an observed native prefix; read inbox again');
    }
    const canonical = interrupts.map(input => canonicalInterrupt(board, agentId, input, observedThrough));
    const added = [];
    for (const interrupt of canonical) {
      const pendingKey = prefix(agentId, 'pending') + interrupt.id;
      if (value(board, pendingKey) || value(board, prefix(agentId, 'acted') + interrupt.id)) continue;
      save(board, pendingKey, interrupt);
      added.push(interrupt.id);
    }
    const key = prefix(agentId, 'cursor');
    const before = value(board, key) ?? { through: 0, digestThrough: 0 };
    const next = { through: Math.max(before.through, through), digestThrough: Math.max(before.digestThrough, digestThrough ?? 0) };
    if (added.length || next.digestThrough > before.digestThrough) {
      save(board, key, next);
      logEvent(board, agentId, 'activity-delivered', null, { interrupts: added, through, observedThrough, ...(digestThrough === undefined ? {} : { digestThrough }) });
    }
    return activityDeliveryState(board, agentId);
  });
}

/** Acknowledgement is explicit and recipient-owned; a read or local cursor can never create it. */
export function actOnActivity(board, { agentId, ids }, { atomic, logEvent }) {
  return atomic(board, () => {
    recipient(board, agentId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || id.length > 256)) {
      throw new Refused('BAD_ACTIVITY_RECEIPT', 'name the interrupt ids returned by your inbox');
    }
    const unique = [...new Set(ids)];
    const records = unique.map(id => {
      const pending = value(board, prefix(agentId, 'pending') + id);
      if (!pending && !value(board, prefix(agentId, 'acted') + id)) {
        throw new Refused('ACTIVITY_NOT_DELIVERED', 'that interrupt was not delivered to this seat; read your own inbox first');
      }
      return pending;
    });
    const acted = [];
    for (const [index, record] of records.entries()) if (record) {
      const id = unique[index];
      save(board, prefix(agentId, 'acted') + id, record);
      board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(prefix(agentId, 'pending') + id);
      acted.push(id);
    }
    if (acted.length) logEvent(board, agentId, 'activity-acted', null, { interrupts: acted });
    return activityDeliveryState(board, agentId);
  });
}
