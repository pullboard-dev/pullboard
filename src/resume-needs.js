/** Resume's complete person obligations without adding optional projections to the status path [N19,N26]. */
import * as store from './board.js';
import { pendingFit } from './blueprint-fit.js';
import { projectFit } from './blueprint-fit.js';
import { repoInfo } from './git.js';
import { personNeedsSummary } from './needs-summary.js';
import { personNeeds } from './row-decision-text.js';
import { resumeRigorCounters } from './rigor-counters.js';

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
