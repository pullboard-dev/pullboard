/** Internal atomic persistence for validated public drafts and canonical automatic proposals [D1]. */

/** Reserve an id and record the exact proposal; callers establish their own input policy first. */
export function recordRowDraft(board, { agentId, row, written = false }, { atomic, logEvent, rowDrafts }) {
  return atomic(board, () => {
    const current = rowDrafts(board);
    // The same writer asking again for the same definition, as a resumed blueprint add does, keeps the id
    // it reserved; a different gate, tier, section, target or writer is another proposal and gets its own id.
    const same = current.find((draft) => draft.id === row.id && draft.by === agentId && draft.written === Boolean(written)
      && ['text', 'gate', 'tier', 'section'].every((key) => (draft[key] ?? '') === (row[key] ?? '')) && draft.target === (row.target ?? 'spec')
      && (row.revises === undefined ? draft.revises === undefined : ['revises', 'file', 'source', 'replacement', 'status', 'reason'].every(key => draft[key] === row[key])));
    if (same) return same;
    const [, prefix, number] = /^(.*?)(\d+)$/u.exec(row.id);
    let next = Number(number);
    while (current.some((draft) => draft.id === `${prefix}${next}`)) next += 1;
    logEvent(board, agentId, 'row_draft', null, { row, written: Boolean(written) });
    const entry = { id: `${prefix}${next}`, text: row.text, gate: row.gate ?? '', tier: row.tier ?? '', section: row.section ?? '', target: row.target ?? 'spec',
      written: Boolean(written), by: agentId, event: board.lastEvent.event_id, at: board.lastEvent.event_at,
      ...(row.revises ? Object.fromEntries(['revises', 'file', 'source', 'replacement', 'status', 'reason'].map(key => [key, row[key]])) : {}) };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run('row_drafts', JSON.stringify([...current, entry]));
    return entry;
  });
}

/** Current person decisions, including applied receipts, stored without checkout-dependent state. */
export function rowDecisions(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('row_decisions');
  return row ? JSON.parse(row.meta_value) : [];
}
