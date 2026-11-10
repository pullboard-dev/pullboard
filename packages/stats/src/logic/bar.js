/** Pure bar attribution over immutable native history [R1,R2,CD64]. */
import { proofEventDetail } from '../../../kernel/browser.js';

/**
 * Per author of a bar: corrections, rejects caused by a bar, and rejects caused by the build.
 * A correction and the reject it explains count to the agent who corrected the bar; any other
 * reject counts as the build's, to the agent who added the item.
 *
 * @param {any[]} history every event, oldest first
 * @param {any[]} verdicts every verdict row
 * @param {string | null} boundary an inclusive ISO start, or null for all time
 * @returns {Record<string, { corrections: number, barRejects: number, buildRejects: number }>}
 */
export function barStats(history, verdicts, boundary) {
  const inWindow = (at) => !boundary || Date.parse(at) >= Date.parse(boundary);
  const creators = new Map();
  const explained = new Set();
  const result = {};
  /** The counters for one agent, created on first use. */
  const of = (agent) => (result[agent] ??= { corrections: 0, barRejects: 0, buildRejects: 0 });
  for (const event of history) {
    if (event.event_kind === 'add') creators.set(event.item_id, event.event_by);
    const correction = event.event_kind === 'edit' ? proofEventDetail(event).barCorrection : null;
    if (!correction) continue;
    if (correction.reject) explained.add(correction.reject.verdict);
    if (!inWindow(event.event_at)) continue;
    of(event.event_by).corrections += 1;
    if (correction.reject) of(event.event_by).barRejects += 1;
  }
  for (const verdict of verdicts) {
    if (verdict.verdict_decision !== 'REJECT' || explained.has(verdict.verdict_id) || !inWindow(verdict.verdict_at)) continue;
    of(creators.get(verdict.item_id) ?? 'unknown').buildRejects += 1;
  }
  return result;
}

