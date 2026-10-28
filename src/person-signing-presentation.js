import { itemCheckBaseline } from './board-query.js';
/** Preserve the signing item's device-facing fields in the shared native/relay projection [E22,H16]. */
import * as store from './board.js';
import { loadSpec } from './spec.js';
import { loadDoctrine } from './doctrine.js';
import { shownDecisionRows } from './row-decisions.js';
import { personRequestRecords } from './relay-requests.js';
import {
  barDigest,
  barReadiness,
} from './bar-readiness.js';
import { mainPolicy } from './trusted-policy.js';
import { previewBarCoverage } from './bar-coverage.js';
import { Refused } from './refused.js';

/** Read the exact rows and pending proposals the registered signing device can present. */
export function personSigningPresentation(root, board, config) {
  // The passkey device reads whether person moves are signed and which terminal-started moves wait for it [E22].
  const requested = new Set(personRequestRecords(board).map((record) => record.id));
  const personProposals = store.personProposals(board).filter((proposal) => !requested.has(proposal.id));
  const signed = store.personSigning(board).signed;
  const ids = signed ? [...loadSpec(root, config).rows.map(row => row.id), ...loadDoctrine(root, config).repo.rows.map(row => `doctrine:${row.id}`)] : [];
  const personRows = signed ? shownDecisionRows(root, config, ids) : [];
  let personBars = [];
  if (signed) {
    const entries = store.listItems(board, { all: true }).map(item => ({ item, status: barReadiness(board, item, { signature: false }, { itemCheckBaseline }) }));
    // A board with no committed policy yet still shows its bars, only without their coverage preview.
    let policy = null;
    try { policy = mainPolicy(root); } catch (error) { if (!(error instanceof Refused)) throw error; }
    const plans = policy ? previewBarCoverage(root, entries.map(({ item, status }) => ({ item, coverage: status.signed?.coverage })), policy) : [];
    personBars = entries.map(({ item, status }, index) => ({ id: item.item_id,
      before: { revision: status.revision?.revision ?? 0, digest: barDigest(item) }, ...(plans[index] ? { coverage: plans[index] } : {}) }));
  }
  return { personSigning: { signed }, personProposals, personRows, personBars };
}
