/**
 * A project's sidebar summary: its item counts, what needs the person and its last change, without its items,
 * events or spec (U94). It is a few numbers and one timestamp, so a listed project costs well under 2 KB however
 * large its board grows; the page reads a full state only for the project that is opened.
 *
 * The page embeds this function's source, so it stays self-contained: no imports, no closures.
 *
 * @param {{items?: object[], events?: object[], sequence?: number}} state - A board state, summary or full.
 * @param {{kind: string, count?: number}[]} needs - The person's needs for that state, as personNeeds returns them.
 * @returns {{version: 1, sequence: number|null, building: number, awaiting: number, sentBack: number, open: number,
 *   verified: number, decisions: number, pending: number, drafts: number, holds: number,
 *   lastChange: {at: string, eventId: number}|null}}
 */
export function projectSummary(state, needs) {
  /** Count the calls of one kind, with draft rows keeping their individual count. */
  const calls = (kind) => needs.filter((row) => row.kind === kind).reduce((total, row) => total + (row.count ?? 1), 0);
  let building = 0, awaiting = 0, sentBack = 0, open = 0, verified = 0;
  for (const item of state.items ?? []) {
    if (item.status === 'claimed') building++;
    else if (item.status === 'submitted') awaiting++;
    else if (item.status === 'verified') verified++;
    else if (item.status === 'open') {
      open++;
      if (item.verdict && item.verdict.decision === 'REJECT') sentBack++;
    }
  }
  const latest = (state.events ?? [])[0];
  const sequence = Number.isSafeInteger(state.sequence) ? state.sequence : Number.isSafeInteger(latest?.event_id) ? latest.event_id : null;
  return {
    version: 1, sequence, building, awaiting, sentBack, open, verified,
    decisions: calls('decision'), pending: calls('pending'), drafts: calls('draft') + calls('rigor-draft'), holds: calls('hold'),
    lastChange: latest ? { at: String(latest.event_at), eventId: Number(latest.event_id) } : null,
  };
}
