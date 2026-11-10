/** Separate actionable activity from count-only summaries without acknowledging either [R2,N26]. */

/** A lapsing claim is an episode tied to its exact lease, not to a checkout's cursor. */
export const CLAIM_INTERRUPT_WINDOW_MS = 5 * 60 * 1000;

/** Classify a tailored read projection; canonical receipt handling remains a separate ordered write. */
export function classifyActivityDelivery({ agentId, items, activity, shouts, at }) {
  const byShout = new Map(shouts.map(shout => [shout.shout_id, shout]));
  const interrupts = [], direct = [], counts = new Map();
  /** Keep only a compact count for digest activity; item evidence remains on its native thread. */
  const count = kind => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  for (const entry of activity.entries) {
    let reason;
    if (entry.kind === 'reject' && entry.recipient === agentId) reason = 'rejected';
    else if (['stalled', 'unblocked'].includes(entry.kind) && entry.recipient === agentId) reason = entry.kind;
    else if (entry.kind === 'main-moved' && (entry.files?.length || entry.unknownFiles || entry.unknownAdditionalFiles)) reason = 'files-changed';
    else if (entry.kind === 'answer') {
      const reply = byShout.get(entry.shout);
      const question = byShout.get(reply?.shout_answers);
      if (question?.shout_from === agentId && question.shout_decision) reason = 'answered';
    }
    if (reason) interrupts.push({ ...entry, id: `event:${entry.eventId}`, reason });
    else if (entry.shout || entry.typedRequest || entry.unknown) direct.push(entry); // Governing instructions and active coordination remain direct.
    else count(entry.kind);
  }
  const now = Date.parse(at);
  for (const item of items) {
    if (item.item_status !== 'claimed' || item.item_owner !== agentId) continue;
    const until = Date.parse(item.item_lease_until);
    if (!Number.isFinite(until) || until - now > CLAIM_INTERRUPT_WINDOW_MS) continue;
    interrupts.push({ id: `claim:${item.item_id}:${item.item_lease_until}`, reason: 'claim-lapsing',
      kind: 'claim', item: item.item_id, leaseUntil: item.item_lease_until,
      text: `#${item.item_id} claim ${until <= now ? 'has lapsed' : 'is lapsing'}; renew or release it` });
  }
  const digests = [...counts].toSorted(([first], [second]) => first.localeCompare(second)).map(([kind, count]) => ({
    kind, count, text: `${count} ${kind} ${count === 1 ? 'activity' : 'activities'}; details remain on the board`,
  }));
  for (const digest of activity.digests) digests.push({ ...digest,
    text: `${digest.count} ${digest.kind} ${digest.count === 1 ? 'update' : 'updates'}; details remain on the board` });
  return { interrupts, entries: direct, digests, cursor: activity.cursor };
}
