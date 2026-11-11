/** Durable, evidence-only mechanism proposals use the ordinary person approval path [C7,D1]. */
import { atomic } from '../../../store/index.js';
import { allShouts } from '../../../store/index.js';
import { events } from '../../../store/index.js';
import { getShout } from '../../../store/index.js';
import { logEvent } from '../../../store/index.js';
import { rowDrafts } from '../../../store/index.js';
import { automaticRigorSource } from '../../../store/index.js';
import { automaticSourceFromText } from '../../../store/index.js';
import { readAutomaticRigorSource } from '../../../store/index.js';
import { recordRowDraft } from '../../../spec/index.js';
import { RIGOR_INSTRUCTIONS_ENGINE } from '../../../state/index.js';
import { coordinatorInstructionKinds } from '../logic/instructions.js';
import { coordinatorInstructionReport } from '../logic/instructions.js';

/** The third original coordinator instruction records one spec proposal per kind in its enclosing transaction. */
export function recordCoordinatorInstructionDrafts(board, trigger) {
  if (trigger.event_by !== 'coordinator') return;
  const detail = JSON.parse(trigger.event_detail);
  const message = getShout(board, detail.shout);
  if (!coordinatorInstructionKinds(message.shout_text).length) return;
  const report = coordinatorInstructionReport(allShouts(board, { from: 'coordinator', since: new Date(new Date(trigger.event_at).getTime() - 7 * 86_400_000).toISOString() }), { now: trigger.event_at });
  for (const entry of report.kinds.filter(entry => entry.count >= report.threshold)) {
    const key = `instruction:${entry.kind}`;
    if (rowDrafts(board).some(row => readAutomaticRigorSource(automaticSourceFromText(row.text))?.key === key)) continue;
    const ids = new Set(entry.shouts.map(shout => shout.id));
    const evidence = events(board).filter(event => ['shout', 'shout_news'].includes(event.event_kind)
      && event.event_by === 'coordinator' && ids.has(JSON.parse(event.event_detail).shout)).map(event => event.event_id);
    const source = automaticRigorSource({ key, items: [], occurrences: entry.count }, evidence);
    const row = recordRowDraft(board, { agentId: 'rigor', row: { id: `RI${trigger.event_id}1`, target: 'spec', tier: 'aim', section: 'RG', gate: 'review',
      text: `${entry.mechanism} Evidence: coordinator ${entry.kind} instructions in shouts ${entry.shouts.map(shout => `#${shout.id}`).join(', ')}. No mechanism is enforced until the person approves it. Source: ${source}` } }, { atomic, logEvent, rowDrafts });
    logEvent(board, 'rigor', 'rigor-draft', null, { engine: RIGOR_INSTRUCTIONS_ENGINE, id: row.id, target: 'spec', cause: key,
      source, unproved: true, items: [], occurrences: entry.count });
  }
}
