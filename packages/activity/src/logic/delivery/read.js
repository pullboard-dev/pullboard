/** Read a recipient's interrupt obligations without consuming a message or writing an acknowledgement [R2,N26,H16]. */
import { activityEventDetail } from '../../../../store/index.js';
import { classifyActivityDelivery } from '../delivery.js';
import { board_activity_delivery_store_activityDeliveryState as activityDeliveryState } from '../../../../store/index.js';
import { rejectionRecipient } from '../../../../store/index.js';

/** Retain exact native references when supplementing the legacy projection with an original builder's rejection. */
function rejectionEntry(event, agentId) {
  return { id: `event:${event.event_id}`, eventId: event.event_id, at: event.event_at, by: event.event_by,
    kind: 'reject', item: event.item_id, recipient: agentId, text: `#${event.item_id} was rejected` };
}

/**
 * Read old and new complete state in one SQLite snapshot, including immutable answer and rejection recipients.
 * Why: the activity projection reads the store's shell, so the shell hands it in as `agentActivity` [C7].
 *
 * @param {(board: any, agentId: string, options: any) => any} agentActivity
 * @param {any} board
 * @param {string} agentId
 * @param {any} [options]
 */
export function readActivityDeliveryWith(agentActivity, board, agentId, options = {}) {
  board.db.exec('SAVEPOINT activity_delivery_read');
  try {
    const state = activityDeliveryState(board, agentId);
    const activity = agentActivity(board, agentId, { ...options,
      after: Math.min(state.through, state.digestThrough), newsAfter: state.digestThrough, sessionStart: true });
    const entries = new Map(activity.entries.map(entry => [entry.eventId, entry]));
    const rejected = board.db.prepare(`SELECT * FROM event WHERE event_kind='reject' AND event_id>? AND event_id<=? ORDER BY event_id`)
      .all(state.through, activity.cursor);
    for (const event of rejected) {
      const detail = activityEventDetail(event);
      if (detail && rejectionRecipient(board, event, detail) === agentId) entries.set(event.event_id, rejectionEntry(event, agentId));
    }
    const notices = board.db.prepare(`SELECT * FROM event WHERE event_kind IN ('claim_stalled','work_notice') AND event_id>? AND event_id<=? ORDER BY event_id`)
      .all(state.through, activity.cursor);
    for (const event of notices) {
      const detail = activityEventDetail(event);
      if (detail?.holder !== agentId) continue;
      const kind = event.event_kind === 'claim_stalled' ? 'stalled' : detail.kind;
      if (!['stalled', 'unblocked'].includes(kind)) continue;
      entries.set(event.event_id, { id: `event:${event.event_id}`, eventId: event.event_id, at: event.event_at, by: event.event_by,
        kind, item: event.item_id, recipient: agentId, text: `#${event.item_id} is ${kind}; read its board progress and act` });
    }
    const messages = new Map();
    for (const entry of entries.values()) if (entry.shout) {
      const message = board.db.prepare('SELECT * FROM shout WHERE shout_id=?').get(entry.shout);
      if (!message) continue;
      messages.set(message.shout_id, message);
      if (message.shout_answers !== null) {
        const question = board.db.prepare('SELECT * FROM shout WHERE shout_id=?').get(message.shout_answers);
        if (question) messages.set(question.shout_id, question);
      }
    }
    const all = classifyActivityDelivery({ agentId,
      // Classification reads items only for this seat's own lapsing claims, so it never lists the whole board (#2421).
      items: board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner=? ORDER BY item_id").all(agentId),
      activity: { ...activity, entries: [...entries.values()] }, shouts: [...messages.values()],
      at: board.clock.now().toISOString() });
    const pending = new Map(state.pending.map(interrupt => [interrupt.id, interrupt]));
    const fresh = [];
    for (const interrupt of all.interrupts) {
      if (pending.has(interrupt.id)) continue;
      const done = board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?')
        .get(`activity:${agentId}:acted:${interrupt.id}`);
      if (done) continue;
      pending.set(interrupt.id, interrupt);
      fresh.push(interrupt);
    }
    const breakTime = options.sessionStart === true || options.afterSubmit === true;
    return { ...all, interrupts: [...pending.values()],
      digests: breakTime ? all.digests : [],
      // The ordered writer consumes this observation separately, after choosing what was actually rendered.
      observation: { fresh, through: activity.cursor, observedThrough: activity.cursor, ...(breakTime ? { digestThrough: activity.cursor } : {}) },
      shoutCursor: activity.shoutCursor, newsShouts: activity.newsShouts };
  } finally {
    board.db.exec('RELEASE activity_delivery_read');
  }
}
