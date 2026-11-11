/** Recent merge collisions are architectural advice, separate from proof-bound Rigor causes [D1]. */
import { shownPath } from '../../../kernel/index.js';

import {
  conflictNoteFiles,
  reopenConflictEvidence,
} from '../../../items/index.js';
export { conflictNoteFiles } from '../../../items/index.js';

const WINDOW_DAYS = 14;
const HOT_ITEMS = 2;

/** Count each recent reopen or hold once per exact file, retaining inspectable event provenance. */
export function conflictReport(events, { now = new Date() } = {}) {
  const until = new Date(now).getTime();
  const since = until - WINDOW_DAYS * 86_400_000;
  const byFile = new Map();
  const unattributed = new Map();
  const seen = new Set();
  for (const event of events) {
    if (!['reopen', 'hold_item'].includes(event.event_kind) || !Number.isInteger(event.item_id) || event.item_id < 1) continue;
    const at = Date.parse(event.event_at);
    if (!Number.isFinite(at) || at < since || at > until || seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    const detail = JSON.parse(event.event_detail);
    const evidence = { id: event.event_id, item: event.item_id, kind: event.event_kind, at: event.event_at };
    let files = null;
    const conflict = event.event_kind === 'reopen' ? reopenConflictEvidence(detail) : null;
    if (conflict) files = conflict.files;
    if (event.event_kind === 'hold_item') {
      files = conflictNoteFiles(detail.reason);
      if (!files && /\bconflicts?\b/iu.test(detail.reason ?? '')) {
        if (!unattributed.has(event.item_id)) unattributed.set(event.item_id, []);
        unattributed.get(event.item_id).push(evidence);
      }
    }
    for (const file of files ?? []) {
      if (!byFile.has(file)) byFile.set(file, { file, reopens: 0, holds: 0, items: new Set(), events: [] });
      const entry = byFile.get(file);
      entry[event.event_kind === 'reopen' ? 'reopens' : 'holds'] += 1;
      entry.items.add(event.item_id);
      entry.events.push({ ...evidence, source: event.event_kind === 'reopen' ? conflict.source : 'machine-note-syntax' });
    }
  }
  const conflictFiles = [...byFile.values()].map(entry => ({ ...entry, items: [...entry.items].sort((a, b) => a - b),
    events: entry.events.sort((a, b) => a.id - b.id) })).sort((a, b) => b.items.length - a.items.length || a.file.localeCompare(b.file));
  return { conflictWindow: { days: WINDOW_DAYS, since: new Date(since).toISOString(), until: new Date(until).toISOString(), thresholdItems: HOT_ITEMS },
    conflictFiles, hotFiles: conflictFiles.filter(file => file.items.length >= HOT_ITEMS),
    unattributedHolds: [...unattributed].sort(([a], [b]) => a - b).map(([item, events]) => ({ item, events })) };
}

/** Render exact paths safely on one terminal or Markdown line without changing their stored identity. */
function displayFile(file) {
  return JSON.stringify(file).replaceAll('|', '\\u007c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

/** Name the cost and missing attribution without presenting a split suggestion as a proved rule. */
export function conflictLines(report) {
  const lines = report.hotFiles.map(file => `hot file ${displayFile(file.file)}: ${file.reopens} conflict reopens, ${file.holds} conflict holds in 14 days; items ${file.items.map(id => '#' + id).join(', ')}; propose a split with pullboard rigor --draft-splits (coordinator, person approval required)`);
  if (report.unattributedHolds.length) lines.push(`conflict holds without attributable files: ${report.unattributedHolds.map(entry => '#' + entry.item + ' (' + entry.events.length + ')').join(', ')}; no paths inferred from prose`);
  return lines;
}

/** A durable ordinary proposal names the file and exact contributing events; it is never rigor: proof. */
export function splitProposal(file) {
  return { text: `Consider splitting ${displayFile(file.file)} into independently owned modules (for example, one module per command). It caused ${file.reopens} conflict reopens and ${file.holds} conflict holds across items ${file.items.map(id => '#' + id).join(', ')} in 14 days; review the architecture before deciding.`,
    source: 'conflict-split:' + Buffer.from(JSON.stringify({ file: file.file, events: file.events.map(event => event.id) })).toString('base64url') };
}

/** Suppress a live same-file proposal or the same previously decided evidence, including board reservations. */
export function splitAlreadyProposed(rows, file) {
  const proposal = splitProposal(file);
  return rows.some(row => {
    const source = /(?:^|\s)Source: (conflict-split:([A-Za-z0-9_-]+))(?:\s|$)/u.exec(row.text ?? '');
    if (!source) return false;
    try {
      const previous = JSON.parse(Buffer.from(source[2], 'base64url').toString('utf8'));
      return previous.file === file.file && (row.status === 'draft' || source[1] === proposal.source);
    } catch { return false; /* Unrelated or malformed source text cannot suppress a proposal. */ }
  });
}
