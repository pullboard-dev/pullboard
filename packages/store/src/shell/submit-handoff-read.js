/** Read-only queued-submit projections never grant proof or actor authority [V4,H16]. */
const PREFIX = 'submit_handoff:';

/** Read only new-engine queue observations; historical selection has no new metadata. */
export function submitHandoff(board, id) {
  const engines = board.enginePorts.submitHandoffEngines();
  if ((board.executionEngineVersion ?? engines.current) < engines.handoff) return null;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(PREFIX + id);
  return row ? JSON.parse(row.meta_value) : null;
}

/** An active immutable job frees its holder to claim ordinary work without making it reviewable. */
export function pendingSubmitHandoff(board, item) {
  const job = submitHandoff(board, item.item_id);
  return item.item_status === 'claimed' && job?.agentId === item.item_owner && job.digest === item.item_frozen_digest
    && ['queued', 'running'].includes(job.state) ? job : null;
}

/** Return an unchanged worker refusal only while its original claim and frozen bar still match. */
export function submitHandoffFailure(board, item) {
  const job = submitHandoff(board, item.item_id);
  return job?.state === 'red' && (job.agentId === item.item_owner || item.item_status === 'open') && job.digest === item.item_frozen_digest
    ? job.error : null;
}

/** Read the native terminal record for a dead job after its successor takes the item's queue slot [C7,V4]. */
export function endedSubmitHandoff(board, job) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('submit_handoff_ended:' + job);
  return row ? JSON.parse(row.meta_value) : null;
}
