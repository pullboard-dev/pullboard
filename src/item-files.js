import { briefFiles } from './brief.js';

/**
 * The files an item touches, as far as the board knows: the files its submission changed, else the
 * files its brief names.
 *
 * @param {any} item
 * @returns {string[]}
 */
export function itemFiles(item) {
  const changed = (item.item_files ?? '').split('\n').filter(Boolean);
  return [...new Set([...changed, ...briefFiles(item.item_brief ?? '')])];
}

/** Find shared paths against lease-normalized in-flight items, retaining the existing item order. */
function fileCollisions(item, files, items) {
  if (!files.size) return [];
  return items.filter(other => other.item_id !== item.item_id && (other.item_status === 'claimed'
    || other.item_status === 'submitted' || (other.item_status === 'verified' && !other.item_merged_commit)))
    .map(other => ({ item: other, shared: itemFiles(other).filter(path => files.has(path)) }))
    .filter(other => other.shared.length);
}

/** Name overlaps with current in-flight items; callers supply lease-normalized board records. */
export function itemFileCollisions(item, items) {
  return fileCollisions(item, new Set(briefFiles(item.item_brief ?? '')), items)
    .map(other => `#${item.item_id} waits for #${other.item.item_id} (${other.item.item_status}) on ${other.shared.join(', ')}`);
}

/** Only newly declared paths can create an edit notice; prose, order and removals are silent. */
export function addedFileCollisions(before, after, items) {
  const previous = new Set(briefFiles(before.item_brief ?? ''));
  const added = new Set(briefFiles(after.item_brief ?? '').filter(path => !previous.has(path)));
  return fileCollisions(after, added, items).map(other => ({ ...other, shared: other.shared.toSorted() }));
}

/** Persist both holder notices with the edit; a fixed system sender also reaches an editing holder's inbox. */
export function notifyFileGrowth(board, before, after, { engineVersion, noticeEngine, coordinator, listItems, persistShout, logEvent }) {
  if ((board.executionEngineVersion ?? engineVersion) < noticeEngine
    || !['claimed', 'submitted'].includes(before.item_status)) return;
  for (const collision of addedFileCollisions(before, after, listItems(board, { all: true }))) {
    const recipients = new Map();
    for (const item of [before, collision.item]) {
      const holder = item.item_owner || item.item_built_by;
      const to = holder && board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(holder) ? holder : coordinator;
      recipients.set(to, [...(recipients.get(to) ?? []), item.item_id]);
    }
    const text = `New file overlap: #${after.item_id} grew into #${collision.item.item_id} on ${collision.shared.join(', ')}. Coordinate both items; the edit is retained.`;
    for (const [to, items] of recipients) {
      const detail = { changedItem: after.item_id, otherItem: collision.item.item_id, files: collision.shared };
      const shout = persistShout(board, { from: 'overlap', to, text, detail: { ...detail, item: items[0] } });
      // One holder may own both items: deliver once while retaining the notice on both item threads.
      for (const item of items.slice(1)) logEvent(board, 'overlap', 'shout', item, { ...detail, shout, to, text });
    }
  }
}
