/** A failure move creates a durable, unproved proposal without writing a repository file [D1,H16]. */
import { atomic } from '../../../store/index.js';
import {
  events,
  logEvent,
  PERSON,
} from '../../../store/index.js';
import { recordRowDraft } from '../../../spec/index.js';
import { rowDrafts } from '../../../store/index.js';
import {
  causeProblem,
  eventCauses,
  rigorReport,
  testCause,
} from '../../../store/index.js';
import {
  conflictNoteFiles,
  conflictReport,
  splitProposal,
} from './conflicts.js';
import { NATIVE_FLAKE_ENGINE } from '../../../state/light.js';
import {
  automaticRigorSource,
  automaticSourceFromText,
  readAutomaticRigorSource,
} from '../../../store/index.js';
import { RIGOR_AUTO_ENGINE } from '../../../state/light.js';
import { REOPEN_CAUSE_ENGINE } from '../../../state/light.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { conflictCause } from '../../../items/index.js';
import { recordCoordinatorInstructionDrafts } from './broadcasts.js';

/** Prefer structured exact-head failures; a coded fallback is a coarse category, never a root-cause finding. */
export function deriveRigorCause(board, item, { cause, reason, conflict, landingFailure, agentId }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= REOPEN_CAUSE_ENGINE && conflict?.files?.length) return conflictCause(conflict.files);
  if (cause !== undefined && cause !== null) return { cause };
  if (conflict?.files?.length) return conflictCause(conflict.files);
  const landing = landingFailure?.tests?.find(failure => !causeProblem(testCause(failure)));
  if (landing) return { cause: testCause(landing), causeDerivation: { kind: 'landing-failure', mergeCommit: landingFailure.mergeCommit } };
  const history = events(board);
  const submitted = history.findLast(event => event.item_id === item.item_id && event.event_kind === 'submit')?.event_id ?? 0;
  const failure = history.findLast(event => {
    if (event.event_id <= submitted || event.event_kind !== 'flake-observation' || event.event_by !== agentId) return false;
    const detail = JSON.parse(event.event_detail);
    const observation = detail.observation;
    return detail.engine === NATIVE_FLAKE_ENGINE && observation?.kind === 'verify' && observation.head === item.item_commit
      && observation.original?.green === false && typeof observation.file === 'string' && typeof observation.name === 'string'
      && !causeProblem(testCause(observation));
  });
  if (failure) return { cause: testCause(JSON.parse(failure.event_detail).observation),
    causeDerivation: { kind: 'recorded-failure', event: failure.event_id } };
  return { cause: `refusal:${reason ?? 'REOPENED'}`, causeDerivation: { kind: reason ? 'verdict-reason' : 'reopen-category', coarse: true } };
}

/** Any draft of this key for this target suppresses another: pending, approved or declined. A person's decline is final
 * for its key, so a later occurrence never re-drafts it under a new id (GitHub #26). */
function proposalSuppressed(draft, cause) {
  return readAutomaticRigorSource(automaticSourceFromText(draft.text))?.key === cause.key;
}

/** Draft the existing threshold's ordinary advice inside its triggering board transaction, never proving it. */
export function recordAutomaticRigorDrafts(board, trigger, shout) {
  if (['shout', 'shout_news'].includes(trigger.event_kind)) return recordCoordinatorInstructionDrafts(board, trigger);
  const detail = JSON.parse(trigger.event_detail);
  const keys = new Set(eventCauses(trigger));
  if (trigger.event_kind === 'fact' && trigger.event_by === PERSON && detail.neverAgain) keys.add(detail.cause);
  // A coordinator reopen that only corrects a bar carries the coarse reopen category, not a failure (GitHub #26).
  if (trigger.event_kind === 'reopen' && detail.causeDerivation?.kind === 'reopen-category') keys.delete(detail.cause);
  // A move that names no cause and no conflicting file can draft nothing. Why return before reading history: the
  // whole event log is read inside the move's write transaction, and on a 380,000-event board a plain hold kept the
  // write lock for seconds doing it [C7].
  const conflictFiles = trigger.event_kind === 'reopen' ? detail.conflict?.files
    : trigger.event_kind === 'hold_item' ? conflictNoteFiles(detail.reason) : null;
  if (!keys.size && !conflictFiles?.length) return;
  const history = events(board);
  const causes = rigorReport(history, { person: PERSON }).causes.filter(cause => keys.has(cause.key));
  const conflicts = conflictReport(history, { now: board.clock.now() }).hotFiles
    .filter(file => trigger.event_kind === 'reopen' && detail.conflict?.files?.includes(file.file)
      || trigger.event_kind === 'hold_item' && conflictNoteFiles(detail.reason)?.includes(file.file))
    .map(file => ({ key: `conflict:${encodeURI(file.file)}`, reads: 'work', items: file.items.map(id => ({ id, commits: [] })),
      occurrences: file.events.length, neverAgain: false, split: file }));
  for (const cause of [...causes, ...conflicts]) {
    const eventIds = cause.split ? cause.split.events.map(event => event.id)
      : history.filter(event => eventCauses(event).includes(cause.key)
        || event.event_kind === 'fact' && event.event_by === PERSON && JSON.parse(event.event_detail).cause === cause.key).map(event => event.event_id);
    const targets = cause.reads === 'both' ? ['doctrine', 'spec'] : [cause.reads === 'product' ? 'spec' : 'doctrine'];
    const created = [];
    for (const target of targets) {
      if (rowDrafts(board).some(draft => draft.target === target && proposalSuppressed(draft, cause))) continue;
      const source = automaticRigorSource(cause, eventIds);
      const advice = cause.split ? splitProposal(cause.split).text
        : `Review how to prevent repeated ${JSON.stringify(cause.key).replaceAll('|', '\\u007c')} (${cause.items.map(item => `#${item.id}`).join(', ') || 'person-marked never again'}). No remedy or red/green proof has been established.`;
      const entry = recordRowDraft(board, { agentId: 'rigor', row: { id: `RG${trigger.event_id}1`, target,
        text: `${advice} Source: ${source}`, gate: 'review', tier: 'aim', section: 'RG' } }, { atomic, logEvent, rowDrafts });
      logEvent(board, 'rigor', 'rigor-draft', null, { engine: RIGOR_AUTO_ENGINE, id: entry.id, target, cause: cause.key,
        source, unproved: true, items: cause.items, occurrences: cause.occurrences });
      created.push({ id: entry.id, target });
    }
    if (created.length) {
      logEvent(board, 'rigor', 'rigor-notice', null, { engine: RIGOR_AUTO_ENGINE, cause: cause.key,
        items: cause.items, occurrences: cause.occurrences, neverAgain: cause.neverAgain, drafts: created });
      shout(board, { from: 'rigor', to: 'coordinator', text: `Rigor recorded unproved ${created.map(entry => `${entry.target} draft ${entry.id}`).join(' and ')} for ${cause.key}, from ${cause.items.map(item => `#${item.id}`).join(', ') || 'the person’s never-again decision'}. It is in Needs you; no rule was approved or applied.` });
    }
  }
}
