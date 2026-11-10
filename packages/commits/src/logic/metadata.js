/** Generate work-commit metadata from the seat's claim, never from an author's assertion [C7]. */
import {
  buildCommitMessage,
  parseCommitMessage,
} from "./message.js";
import { landingRows } from "./landing.js";

/** Validate supplied metadata before replacing it with the board's canonical trailer paragraph. */
export function prepareCommitMetadata(raw, { claim = null, claims = null, landings = [], spec = null, syncMerge = false, migration = null } = {}) {
  const message = raw.replace(/\r\n/gu, '\n').split('\n').filter(line => !line.startsWith('#')).join('\n').trimEnd();
  if (syncMerge && /^Merge /u.test(message)) return { message: raw, problems: [] };
  const parsed = parseCommitMessage(message);
  const problems = [];
  if (!parsed.type) problems.push('write a typed header: type(scope): subject; only Git sync merges are exempt');
  const supplied = message.split('\n').filter(line => /^\s*Pullboard-/iu.test(line));
  const allMetadata = parsed.trailers.filter(entry => /^Pullboard-/iu.test(entry.key));
  const migrationRows = allMetadata.filter(entry => entry.key === 'Pullboard-Migration');
  const validMigration = migrationRows.length === 1 && syncMerge
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(migration?.base ?? '')
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(migration?.side ?? '')
    && migration.base !== migration.side && migrationRows[0].value === migration.base;
  const metadata = allMetadata.filter(entry => entry.key !== 'Pullboard-Migration');
  if (migrationRows.length && !validMigration) problems.push('Pullboard-Migration needs the coordinator merge with its actual first parent');
  const held = claims ?? (claim ? [claim] : []);
  if (held.length > 1) {
    problems.push(`this checkout's seat holds ${held.map(item => `#${item.item_id}`).join(', ')}; commit from the item's own worktree; Pullboard generates its trailers`);
    for (const item of held) problems.push(`if you no longer work on #${item.item_id}, clear only that claim: pullboard release ${item.item_id} --reason OTHER --note "no longer working this claim" --no-next`);
  }
  const expected = held.length > 1 ? null : held[0] ?? landings.find(item => item.item_id === parsed.item);
  if (supplied.length !== allMetadata.length) problems.push('keep Pullboard trailers together in the final paragraph, with no text after them');
  if (metadata.some(entry => !['Pullboard-Item', 'Pullboard-Rows'].includes(entry.key))) problems.push('the Pullboard- trailer prefix is reserved for Item and Rows');
  for (const key of ['Pullboard-Item', 'Pullboard-Rows']) {
    if (metadata.filter(entry => entry.key === key).length > 1) problems.push(`write only one ${key} trailer`);
  }
  if (!expected) {
    if (metadata.length) problems.push('Pullboard trailers need this seat\'s live claim or a verified item in the landing checkout');
    return { message: raw, problems };
  }
  const rows = landingRows(expected, spec);
  if (metadata.some(entry => entry.key === 'Pullboard-Item') && parsed.item !== expected.item_id) problems.push(`Pullboard-Item must name this board item #${expected.item_id}`);
  if (parsed.rows !== null && parsed.rows.join(',') !== rows.join(',')) problems.push('Pullboard-Rows must match the frozen rows in spec order');
  if (!rows.length && parsed.rows !== null) problems.push('omit Pullboard-Rows for an item with no rows');
  const preview = /\[[^\]\n]*\+/u.test(parsed.header);
  if (preview && (!parsed.more || !parsed.shown.length || parsed.shown.join(',') !== rows.slice(0, parsed.shown.length).join(',') || parsed.shown.length + parsed.more !== rows.length)) {
    problems.push('the header preview must show the first frozen rows and +N for exactly the rest');
  }
  const keys = parsed.trailers.map(entry => entry.key);
  const ordered = ['Pullboard-Item', 'Pullboard-Rows'].filter(key => keys.includes(key));
  if (metadata.length && keys.slice(0, metadata.length).join(',') !== ordered.join(',')) problems.push('put Pullboard-Item then Pullboard-Rows before the Git trailers');
  if (problems.length) return { message: raw, problems };
  const generated = buildCommitMessage({ type: parsed.type, scope: parsed.scope, title: parsed.title, item: expected.item_id, rows });
  const trailers = [generated.trailers, ...parsed.trailers.filter(entry => !/^Pullboard-/iu.test(entry.key) || entry.key === 'Pullboard-Migration').map(entry => `${entry.key}: ${entry.value}`)].filter(Boolean).join('\n');
  return { message: [parsed.header, parsed.body, trailers].filter(Boolean).join('\n\n') + '\n', problems };
}
