/** Capture one native receipt cohort without retaining it beyond a publication pass [B3,R3]. */
import * as store from '../../../store/index.js';
import { Refused } from '../../../kernel/index.js';

/** Preserve native row order while making per-item reads independent of the board's total size. */
function byItem(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.item_id) ?? [];
    group.push(row); groups.set(row.item_id, group);
  }
  return groups;
}

/** Reuse the canonical verdict/withdrawal interpreter against exact rows from one SQL snapshot. */
export function capturePrProof(board) {
  board.db.exec('SAVEPOINT pr_proof_snapshot');
  try {
    const items = store.listItems(board, { all: true });
    const verdicts = byItem(board.db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all());
    const events = byItem(store.eventsOfKinds(board, ['accept', 'reject', 'reopen']));
    const metadata = new Map(board.db.prepare(`SELECT meta_key,meta_value FROM board_meta
      WHERE meta_key GLOB 'verdict_assurance:*' OR meta_key GLOB 'outside:*' OR meta_key GLOB 'rehome_import:*' OR meta_key GLOB 'item_source_advance:*' OR meta_key GLOB 'item_patches:*'`).all()
      .map(row => [row.meta_key, row]));
    const batches = store.landingBatches(board);
    // This private reader accepts only the canonical interpreter's known queries. Carry lookups
    // keep SQLite's JSON/error semantics inside this snapshot; the reader never escapes RELEASE.
    const captured = { ...board, db: {
      /** Supply fresh row lists to the existing receipt and withdrawal semantics. */
      prepare(sql) {
        const query = sql.replace(/\s+/gu, ' ').trim();
        if (/^SELECT meta_value FROM board_meta WHERE meta_key\s*=\s*\?$/u.test(query)) return { get: key => metadata.get(key) };
        if (/^SELECT \* FROM verdict WHERE item_id\s*=\s*\? ORDER BY verdict_id$/u.test(query)) return { all: id => [...(verdicts.get(id) ?? [])] };
        if (/^SELECT (?:\*|(?:event_id, )?event_kind, event_detail) FROM event(?:_history)? WHERE item_id\s*=\s*\? AND event_kind (?:IN \('accept', 'reject'\)|= 'reopen') ORDER BY event_id$/u.test(query)) {
          const kinds = /event_kind = 'reopen'/u.test(query) ? ['reopen'] : ['accept', 'reject'];
          return { all: id => (events.get(id) ?? []).filter(row => kinds.includes(row.event_kind)) };
        }
        if (/^SELECT event_detail FROM event(?:_history)? WHERE item_id = \? AND event_kind = 'merge-only-accept' AND json_extract\(event_detail,'\$\.commit'\) = \? ORDER BY event_id DESC LIMIT 1$/u.test(query)
            || /^SELECT 1 FROM event(?:_history)? WHERE item_id = \? AND event_kind = 'merge-only-accept' AND event_id > \? AND event_id < \? AND json_extract\(event_detail,'\$\.commit'\) = \? AND json_extract\(event_detail,'\$\.verdict'\) = \?$/u.test(query)) {
          return board.db.prepare(sql);
        }
        if (query === "SELECT 1 FROM event WHERE item_id=? AND event_kind='accept' AND event_id>? LIMIT 1"
          || query === "SELECT event_id FROM event WHERE item_id=? AND event_kind IN ('submit','reopen','refreeze','reject') ORDER BY event_id DESC LIMIT 1"
          || query === 'SELECT item_commit FROM item WHERE item_id=?') return board.db.prepare(sql);
        throw new Refused('PUBLISH_STATE', 'the native receipt reader changed; update Pullboard before publishing');
      },
    } };
    const accepted = new Map(items.map(item => [item.item_id, store.acceptedVerdict(captured, item)]));
    const outside = new Map();
    for (const item of items) {
      const raw = metadata.get('outside:' + item.item_id)?.meta_value;
      if (raw !== undefined) outside.set(item.item_id, JSON.parse(raw));
    }
    return { items, accepted, outside, batches,
      assurance: verdict => verdict?.imported ? 'imported' : metadata.get('verdict_assurance:' + verdict?.verdict_id)?.meta_value };
  } finally { board.db.exec('RELEASE pr_proof_snapshot'); }
}
