/** Exact conflict classification without changing original events or granting workflow authority [C7,D1]. */
import { conflictNote } from "../../../../kernel/index.js";
import { shownPath } from "../../../../kernel/index.js";

/** Read only the complete canonical machine-note syntax; this is not authenticated Git evidence. */
export function conflictNoteFiles(note) {
  if (typeof note !== 'string') return null;
  const match = /^conflicts with the trunk at ([a-f0-9]{12}) in ([\s\S]+); merge main and resubmit$/u.exec(note);
  if (!match) return null;
  const body = match[2];
  const token = /"(?:[^"\\]|\\.)*"|[\w./@+-]+/uy;
  const files = [];
  let offset = 0;
  while (offset < body.length) {
    token.lastIndex = offset;
    const found = token.exec(body);
    if (!found) return null;
    let file = found[0];
    if (file.startsWith('"')) {
      try { file = JSON.parse(file); }
      catch { return null; /* A malformed quoted path is not a canonical conflict note. */ }
    }
    if (!file || file.includes('\0') || files.includes(file) || shownPath(file) !== found[0]) return null;
    files.push(file);
    offset = token.lastIndex;
    if (offset === body.length) break;
    if (body.slice(offset, offset + 2) !== ', ' || offset + 2 === body.length) return null;
    offset += 2;
  }
  return files.length && conflictNote({ files, trunk: match[1] }) === note ? files : null;
}

/** Read the historical machine-shaped pseudo-test syntax; ambiguous paths remain unclassified. */
export function legacyConflictNote(note) {
  if (typeof note !== 'string') return null;
  const canonical = conflictNoteFiles(note);
  if (canonical) return { files: canonical, source: 'legacy-conflict-note' };
  const match = /^(?<file>[\w./@+-]+): does not merge onto the trunk \(conflicts: (?<files>[\w./@+ -]+)\), reopened for the builder merge; merge commit (?<trunk>[a-f0-9]{40}|[a-f0-9]{64})$/u.exec(note);
  if (!match) return null;
  const files = match.groups.files.split(' ');
  if (files.some(file => !file) || !files.includes(match.groups.file)) return null;
  return { files: [...new Set(files)], source: 'legacy-conflict-note' };
}

/** Prefer recorded structured files; note-derived history is labeled and is never a Git receipt. */
export function reopenConflictEvidence(detail) {
  const conflict = detail?.conflict;
  if (Array.isArray(conflict?.files) && conflict.files.length
    && conflict.files.every(file => typeof file === 'string' && file && !file.includes('\0'))
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(conflict.trunk ?? '')) {
    return { files: [...new Set(conflict.files)], source: 'typed-conflict' };
  }
  return detail?.withdrawnVerdict ? null : legacyConflictNote(detail?.note);
}

/** Give each exact Git path its own cause key, preserving its original path separately. */
export function conflictCause(files) {
  return { cause: 'conflict:' + encodeURI(files[0]), causes: [...new Set(files.map(file => 'conflict:' + encodeURI(file)))],
    causeDerivation: { kind: 'merge-conflict', files: [...files] } };
}

/** Expose a labeled correction beside immutable original thread detail, never inside acceptance inputs. */
export function reopenCauseCorrection(event) {
  if (event.event_kind !== 'reopen') return null;
  const evidence = reopenConflictEvidence(JSON.parse(event.event_detail));
  return evidence?.source === 'legacy-conflict-note' ? { ...conflictCause(evidence.files), source: evidence.source } : null;
}
