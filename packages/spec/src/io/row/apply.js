/** Apply person row decisions and their complete item refreezes in one ordered transaction [V2,H16]. */
import { COORDINATOR } from '../../../../config/index.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../../../../state/light.js';
import { SPEC_DRAFT_REFREEZE_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { Refused } from '../../../../kernel/index.js';
import { rowDecisions } from '../../logic/row/draft.js';
import { markAppliedRevisions } from '../revisions.js';
import {
  needsSpecRefreezes,
  validateSpecRefreezes,
} from '../refreeze.js';

/** Private in-process permission: JSON/sealed refreeze moves cannot supply this symbol. */
export const SPEC_REFREEZE = Symbol('validated cited spec correction');

/** Keep historical row-apply bytes unchanged unless the new correction marker is present. */
export function applySpecRowDecisions(board, options, { refreeze, writeRowDecisions, notice, atomic, logEvent, now, rowDrafts }) {
  const { agentId, events } = options;
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator applies row decisions; ask your coordinator to run pullboard spec apply');
  if (!Array.isArray(events) || events.some(event => !Number.isSafeInteger(event) || event < 1)) throw new Refused('ROW_DECISION', 'apply needs current decision event ids; use pullboard spec apply');
  const corrected = Object.hasOwn(options, 'refreezes');
  const skipsDrafts = Object.hasOwn(options, 'skippedDrafts');
  if (skipsDrafts && (!corrected || (board.executionEngineVersion ?? ENGINE_VERSION) < SPEC_DRAFT_REFREEZE_ENGINE)) {
    throw new Refused('ENGINE_VERSION', 'explicit draft citation omissions require current Pullboard; upgrade linked devices before spec apply');
  }
  if (corrected && (board.executionEngineVersion ?? ENGINE_VERSION) < AUTOMATIC_DISPATCH_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'atomic cited spec corrections require current Pullboard; upgrade every linked device before spec apply');
  }
  return atomic(board, () => {
    const records = rowDecisions(board);
    const found = events.map(event => records.find(record => record.event === event));
    if (found.some(record => !record)) throw new Refused('STALE_ROW_DECISION', 'a row decision was replaced; use pullboard spec apply with the current decisions');
    const applied = found.filter(record => !record.applied);
    if (!corrected && (board.executionEngineVersion ?? ENGINE_VERSION) >= AUTOMATIC_DISPATCH_ENGINE
      && needsSpecRefreezes(applied)) {
      throw new Refused('ROW_DECISION', 'the spec correction is missing its frozen item payloads; run pullboard spec apply again');
    }
    const updates = corrected ? validateSpecRefreezes(board, events, options.refreezes,
      skipsDrafts ? { skippedDrafts: options.skippedDrafts } : {}) : [];
    if (!applied.length) return [];
    const at = now(board);
    writeRowDecisions(board, records.map(record => events.includes(record.event) ? { ...record, applied: true, appliedAt: at } : record));
    markAppliedRevisions(board, applied, at, { rowDrafts });
    for (const { item, frozen } of updates) {
      const result = refreeze(board, item.item_id, { agentId, freeze: () => frozen, [SPEC_REFREEZE]: true });
      if (result.retainedClaim) notice({ from: COORDINATOR, to: item.item_owner, lanes: [],
        text: `The coordinator corrected #${item.item_id} through its cited spec. Its frozen bar is effective now; your claim and lease are retained. Continue with pullboard show ${item.item_id}.` });
    }
    logEvent(board, agentId, 'row_apply', null, { events: applied.map(record => record.event),
      ...(skipsDrafts ? { skippedDrafts: options.skippedDrafts } : {}),
      ...(corrected ? { refreezes: updates.map(({ item, frozen }) => ({ item: item.item_id, before: item.item_frozen_digest, after: frozen.digest })) } : {}) });
    return applied.map(record => ({ ...record, applied: true, appliedAt: at }));
  });
}
