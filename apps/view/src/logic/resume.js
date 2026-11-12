/** Resume's complete person obligations without adding optional projections to the status path [N19,N26]. */
import * as store from '../../../../packages/store/index.js';
import { pendingFit } from '../../../../packages/blueprints/index.js';
import { projectFit } from '../../../../packages/blueprints/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { personNeedsSummary } from './needs/summary.js';
import { personNeeds } from '../../../../packages/spec/index.js';
import { resumeRigorCounters } from '../../../../packages/rigor/index.js';

/** Extend the indexed summary only for resume; retain exact row decisions, fit and coordinator Rigor. */
export function resumeNeeds(root, { board, config, includeRigorUndrafted = false }) {
  const summary = personNeedsSummary(root, { board, config });
  // Resume consumes obligations, not dashboard items. Fit still decorates every current spec row.
  const fitted = projectFit(pendingFit(repoInfo(root).commonDir), { ...summary, items: [] });
  const rigor = includeRigorUndrafted ? resumeRigorCounters(board, summary, { person: store.PERSON,
    drafts: store.rowDrafts(board), decisions: store.rowDecisions(board) }) : null;
  return { ...fitted, needs: personNeeds(fitted), ...(includeRigorUndrafted
    ? { rigorUndrafted: rigor.causes, rigorNotice: rigor.notice } : {}) };
}
