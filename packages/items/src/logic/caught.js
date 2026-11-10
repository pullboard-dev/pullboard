import { proofEventDetail } from "../../../kernel/index.js";
/**
 * What the board caught, read from events it already records [N26,D1]: a quiet list for
 * `pullboard stats` and `pullboard digest`, shown only when someone asks.
 *
 * Why no new event kind: every catch is already a recorded move (a reject verdict, a reopen that
 * names a trunk conflict or a red landing, a proven flake or a quarantined test, a sentinel finding), so the list is a
 * reading of history and adds nothing to it.
 */
import { NATIVE_FLAKE_ENGINE } from "../../../state/light.js";

/** The kinds of catch in the order they print, each with the words its heading uses. */
export const CAUGHT_KINDS = [
  { kind: 'sentBack', label: 'sent back by a reviewer' },
  { kind: 'conflict', label: 'conflicted with the trunk and went back for a merge' },
  { kind: 'redHead', label: 'heads the full suite refused to publish' },
  { kind: 'flake', label: 'flakes proven' },
  { kind: 'stuck', label: 'stuck states the sentinel reported' },
];

/**
 * Parse an event's detail, tolerating a malformed row so one bad record never hides the rest.
 *
 * @param {{ event_detail: string }} event
 * @returns {any}
 */
function detailOf(event) {
  try { return proofEventDetail(event) ?? {}; } catch { return {}; }
}

/**
 * Every catch in the window, newest last, plus a count per kind.
 *
 * @param {Array<{ event_id: number, event_at: string, event_by: string, event_kind: string, item_id: number | null, event_detail: string }>} history the board's events, oldest first
 * @param {Array<{ verdict_id?: number, item_id: number, verdict_decision: string, verdict_commit: string, verdict_note: string, verdict_reason: string }>} verdicts the reviewers' verdicts, which carry the gap each one named
 * @param {string | null} boundary inclusive ISO start of the window, or null for the whole history
 * @returns {{ counts: Record<string, number>, total: number, entries: Array<{ kind: string, item: number | null, at: string, text: string }> }}
 */
export function caughtFrom(history, verdicts, boundary) {
  const start = boundary ? Date.parse(boundary) : null;
  const counts = Object.fromEntries(CAUGHT_KINDS.map(({ kind }) => [kind, 0]));
  const entries = [];
  // Reject moves and their verdict rows are committed together; pairing same-head rows oldest-first keeps each note with its event.
  const rejectsByHead = new Map();
  const rejectOffsets = new Map();
  for (const verdict of verdicts) {
    if (verdict.verdict_decision !== 'REJECT') continue;
    const key = JSON.stringify([verdict.item_id, verdict.verdict_commit]);
    if (!rejectsByHead.has(key)) rejectsByHead.set(key, []);
    rejectsByHead.get(key).push(verdict);
  }
  for (const rejects of rejectsByHead.values()) {
    rejects.sort((left, right) => (left.verdict_id ?? 0) - (right.verdict_id ?? 0));
  }
  /** Record one catch. */
  const add = (kind, event, text) => {
    counts[kind] += 1;
    entries.push({ kind, item: event.item_id ?? null, at: event.event_at, text });
  };
  for (const event of history) {
    const detail = detailOf(event);
    let rejectedVerdict;
    if (event.event_kind === 'reject') {
      const key = JSON.stringify([event.item_id, detail.commit]);
      const offset = rejectOffsets.get(key) ?? 0;
      rejectedVerdict = rejectsByHead.get(key)?.[offset];
      rejectOffsets.set(key, offset + 1);
    }
    if (start !== null && Date.parse(event.event_at) < start) continue;
    if (event.event_kind === 'reject') {
      const gap = rejectedVerdict?.verdict_note || rejectedVerdict?.verdict_reason || detail.reason || 'no gap recorded';
      add('sentBack', event, `${detail.reason ?? 'rejected'}: ${gap}`);
    } else if (event.event_kind === 'reopen' && detail.conflict) {
      const files = Array.isArray(detail.conflict.files) ? detail.conflict.files.join(', ') : '';
      add('conflict', event, `conflicted with the trunk${files ? ` in ${files}` : ''}`);
    } else if (event.event_kind === 'reopen' && detail.landingFailure) {
      const tests = Array.isArray(detail.landingFailure.tests) ? detail.landingFailure.tests.map((test) => `${test.file}: ${test.name}`).join('; ') : '';
      add('redHead', event, `the full suite failed ${tests || 'at landing'}`);
    } else if (event.event_kind === 'flake-observation' && detail.engine === NATIVE_FLAKE_ENGINE && detail.observation?.classification === 'flake') {
      add('flake', event, `${detail.observation.file ?? 'unknown file'}: ${detail.observation.name ?? 'unknown test'} passed on rerun at the same head`);
    } else if (event.event_kind === 'test-quarantine') {
      add('flake', event, `${detail.file ?? 'unknown file'} :: ${detail.name ?? 'unknown test'} went red and green on tree ${detail.tree ?? 'unknown'}`);
    } else if (event.event_kind === 'health-failure' && event.event_by === 'sentinel') {
      add('stuck', event, `${detail.subject ?? detail.key ?? 'a stuck state'} (${String(detail.cause ?? 'refusal').replace(/^refusal:/u, '')})`);
    }
  }
  return { counts, total: entries.length, entries };
}

/**
 * The quiet lines the CLI prints: one count line, then one line per catch with its item and when.
 * Nothing prints when nothing was caught beyond a single "none" line, so the list never grows noise.
 *
 * @param {{ counts: Record<string, number>, total: number, entries: Array<{ kind: string, item: number | null, at: string, text: string }> }} caught
 * @returns {string[]}
 */
export function caughtLines(caught) {
  const counts = CAUGHT_KINDS.map(({ kind, label }) => `${caught.counts[kind]} ${label}`).join(' · ');
  const lines = [`caught: ${caught.total ? counts : 'nothing in this window'}`];
  for (const { kind, label } of CAUGHT_KINDS) {
    for (const entry of caught.entries.filter((row) => row.kind === kind)) {
      lines.push(`  ${label}: ${entry.item === null ? 'no item' : `#${entry.item}`}, ${entry.at}: ${entry.text.replace(/\s+/gu, ' ').trim()}`);
    }
  }
  return lines;
}
