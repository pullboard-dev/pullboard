import { PERSON } from "../query.js";
import { rowDecisions } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { SPEC_REVISION_ENGINE } from "../../../../../state/light.js";
import { validRevisionApproval } from "../../../../../spec/index.js";
import { Refused } from "../../../../../kernel/index.js";
import { parseSpec } from "../../../../../spec/index.js";

/** Persist the current decision index inside its caller's board transaction. */
export function writeRowDecisions(board, records) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run('row_decisions', JSON.stringify(records));
}

/** Record one exact-row decision per event; sender-side channel checks precede deterministic replay. */
export function recordRowDecisions(board, { agentId, channel, decisions }) {
  if (agentId !== PERSON) throw new Refused('B26_PERSON_APPROVAL', 'only the person approves or declines rows; use pullboard view for the person to decide');
  if (!['terminal', 'view'].includes(channel)) throw new Refused('B26_PERSON_CHANNEL', 'row decisions use the terminal or the view; use pullboard view');
  if (!Array.isArray(decisions) || !decisions.length) throw new Refused('ROW_DECISION', 'name at least one row to approve or decline; use pullboard spec approve <ids>');
  const keys = new Set();
  for (const record of decisions) {
    if (!record || !['approve', 'decline'].includes(record.decision) || !['spec', 'doctrine'].includes(record.kind)
      || !['id', 'file', 'source', 'replacement', 'text'].every((key) => typeof record[key] === 'string' && record[key].trim())
      || (record.decision === 'decline' && !String(record.reason ?? '').trim())) throw new Refused('ROW_DECISION', 'a row decision needs its id, file and exact text; use pullboard spec approve or decline');
    const original = parseSpec(`## Decision\n${record.source}\n`).rows;
    const replacement = parseSpec(`## Decision\n${record.replacement}\n`).rows;
    const target = replacement[0];
    const engineVersion = board.executionEngineVersion ?? ENGINE_VERSION;
    const validDeclineText = record.decision !== 'decline' || (engineVersion >= 12
      ? record.text === original[0]?.text
      : target?.text === record.reason);
    const revision = record.revision !== undefined && engineVersion >= SPEC_REVISION_ENGINE && validRevisionApproval(board, record, board.nativePorts);
    if (!revision && (record.revision !== undefined || original.length !== 1 || original[0].id !== record.id || replacement.length !== 1 || target.id !== record.id
      || target.status !== (record.decision === 'approve' ? 'approved' : 'wont') || target.text !== record.text
      || !validDeclineText)) throw new Refused('ROW_DECISION', 'the exact row must match its recorded approval or decline; use pullboard spec approve or decline');
    const key = `${record.kind}:${record.id}`;
    if (keys.has(key)) throw new Refused('ROW_DECISION', `${key} is named twice; use each row once`);
    keys.add(key);
  }
  return atomic(board, () => {
    let current = rowDecisions(board);
    const recorded = decisions.map((record) => {
      logEvent(board, PERSON, 'row_decision', null, { record, channel });
      const entry = { ...record, event: board.lastEvent.event_id, at: board.lastEvent.event_at, applied: false };
      current = [...current.filter((old) => old.kind !== record.kind || old.id !== record.id), entry];
      return entry;
    });
    writeRowDecisions(board, current);
    return recorded;
  });
}
