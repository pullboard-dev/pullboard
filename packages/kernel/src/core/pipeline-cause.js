/** Classify explicit native evidence, never narrative wording or presumed root causes [R1,R2,C7]. */
export const PIPELINE_CAUSES = Object.freeze(['runner-wait', 'flake', 'main-red', 'bar-change', 'conflict', 'companion-wait', 'test-failure', 'host-busy', 'other']);
const CODES = Object.freeze({ RUNNER_WAIT_DEADLINE: 'runner-wait', FLAKE: 'flake', MAIN_RED: 'main-red',
  CRITERIA_CHANGED: 'bar-change', PENDING_REFREEZE: 'bar-change', MERGE_CONFLICT: 'conflict',
  TRUNK_CONFLICT: 'conflict', ITEM_PATCH_CHANGED: 'companion-wait', TEST_FAILURE: 'test-failure',
  BOARD_BUSY: 'host-busy', GIT_READ_INFRASTRUCTURE: 'host-busy', DATABASE_LOCKED: 'host-busy' });

/** Preserve a bounded original explanation for evidence that has no more specific typed category. */
export function pipelineCause({ cause, code, reason, conflict, landingFailure, note = '' } = {}) {
  let type;
  if (conflict?.files?.length || typeof cause === 'string' && cause.startsWith('conflict:')) type = 'conflict';
  else if ((typeof cause === 'string' && cause.startsWith('test:')) || landingFailure?.tests?.length) type = 'test-failure';
  else {
    const value = typeof cause === 'string' && cause.startsWith('refusal:') ? cause.slice(8) : cause;
    type = [value, code, reason].map(key => Object.hasOwn(CODES, key) ? CODES[key] : null).find(Boolean);
  }
  if (type) return { type, ...(code ? { code } : {}), ...(cause ? { cause } : {}), ...(reason ? { reason } : {}) };
  return { type: 'other', text: String(note).slice(0, 4000) || String(code ?? reason ?? cause ?? 'No structured cause was supplied'),
    ...(code ? { code } : {}), ...(cause ? { cause } : {}), ...(reason ? { reason } : {}) };
}

/** A parsed receipt only chooses a known category; malformed or legacy values remain unknown. */
export function pipelineCauseType(value) {
  return value && PIPELINE_CAUSES.includes(value.type) && (value.type !== 'other' || typeof value.text === 'string' && value.text.trim()) ? value.type : null;
}
