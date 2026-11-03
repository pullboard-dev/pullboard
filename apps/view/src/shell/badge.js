/** Board-derived Shields endpoint documents, shared by the command and landing [B3,V1]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** Count finished records and only their current independent, non-self acceptance; unknown lineage proves nothing. */
export function badgeCounts(board) {
  const row = board.db.prepare(`SELECT COUNT(*) AS items,
    COALESCE(SUM(CASE WHEN i.item_built_by IS NOT NULL AND i.item_built_by != ''
      AND v.verdict_by != i.item_built_by AND assurance.meta_value='independent' THEN 1 ELSE 0 END), 0) AS checked
    FROM item i LEFT JOIN verdict v ON v.verdict_id = (
      SELECT MAX(a.verdict_id) FROM verdict a WHERE a.item_id=i.item_id
        AND a.verdict_decision='ACCEPT' AND a.verdict_commit=i.item_commit)
    LEFT JOIN board_meta assurance ON assurance.meta_key='verdict_assurance:' || v.verdict_id
    WHERE i.item_status='verified'`).get();
  return { items: row.items, checked: row.checked, percent: row.items ? Math.floor(row.checked * 100 / row.items) : null };
}

/** Serialize stable endpoint bytes; the zero-item board has no percentage to publish. */
export function badgeDocuments(counts) {
  if (!counts.items) return [];
  return [
    { path: 'docs/badges/items.json', value: { schemaVersion: 1, label: 'pullboard', message: `${counts.items} items`, color: '2f7d5b' } },
    { path: 'docs/badges/checked.json', value: { schemaVersion: 1, label: 'agent-verified', message: `${counts.percent}%`, color: '6e7781' } },
  ].map(document => ({ path: document.path, text: JSON.stringify(document.value, null, 2) + '\n' }));
}

/** Write changed endpoint documents only; an empty board leaves even existing files untouched. */
export function writeBadges(root, counts) {
  const changed = [];
  for (const document of badgeDocuments(counts)) {
    const file = join(root, document.path);
    if (existsSync(file) && readFileSync(file, 'utf8') === document.text) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, document.text);
    changed.push(document.path);
  }
  return changed;
}
