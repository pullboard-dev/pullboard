import { personProposals as nativePersonProposals } from "../../io/signing.js";
import { personSigning as nativePersonSigning } from "../../io/signing.js";
import { itemCheckBaseline } from "../../../../store/light.js";
/** Preserve the signing item's device-facing fields in the shared native/relay projection [E22,H16]. */
import * as store from "../../../../store/index.js";
import { loadSpec } from "../../../../spec/index.js";
import { loadDoctrine } from "../../../../doctrine/light.js";
import { shownDecisionRows } from "../../../../spec/index.js";
import { personRequestRecords } from "../request.js";
import {
  barDigest,
  barReadiness,
} from "../../../../verify/index.js";
import { mainPolicy } from "../../../../sandbox/index.js";
import { previewBarCoverage } from "../../../../verify/index.js";
import { Refused } from "../../../../kernel/light.js";

/** Read the exact rows and pending proposals the registered signing device can present. */
export function personSigningPresentation(root, board, config) {
  // The passkey device reads whether person moves are signed and which terminal-started moves wait for it [E22].
  const requested = new Set(personRequestRecords(board).map((record) => record.id));
  const personProposals = nativePersonProposals(board).filter((proposal) => !requested.has(proposal.id));
  const signed = nativePersonSigning(board).signed;
  const ids = signed ? [...loadSpec(root, config).rows.map(row => row.id), ...loadDoctrine(root, config).repo.rows.map(row => `doctrine:${row.id}`)] : [];
  const personRows = signed ? shownDecisionRows(root, config, ids, { loadDoctrine }) : [];
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
