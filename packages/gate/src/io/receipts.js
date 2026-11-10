/** Seal native receipt bytes and accepted opt-in before this submit can enter the event stream [V4,H16]. */
import { Refused } from '../../../kernel/index.js';
import { createHash } from 'node:crypto';
import { submitGatePlan } from './submit.js';
import { submitGateConfig } from './submit.js';
import { frozenCheck } from '../../../sandbox/index.js';
import { policyAt } from '../../../sandbox/index.js';
import { mainPolicy } from '../../../sandbox/index.js';
import { contains } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { readGateReceipt } from './run/receipt.js';
import { boardReceiptStore } from './run/receipt.js';
import { validateKnownMainAutofile } from '../../../store/index.js';
/** Refuse missing origin evidence without widening generic creation authority. */
function refused() { return new Refused('SUBMISSION_PROOF', 'automatic Main red repairs need native evidence and accepted-main opt-in; rerun submit'); }

/** Seal actual gate-written receipts and accepted policy; caller-supplied receipt or setting bytes are never authority. */
export function sealKnownMainAutofile(board, id, options) {
  if (!options.autoMainReds) return options;
  const request = options.autoMainReds;
  const root = board.gitRoot;
  const policy = policyAt(root, options.policyCommit);
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  // Match submit's bare-source comparison boundary; companions do not become the historical base.
  const source = options.companion?.source ?? options.commit;
  const base = source === options.policyCommit ? item.item_claim_head
    : tryGit(root, ['merge-base', source, options.policyCommit]).stdout.trim();
  if (!contains(root, options.policyCommit, mainPolicy(root).commit) || base !== request.main) throw refused();
  if (policy.config.submit?.autoFileMainReds !== true) throw refused();
  const read = ids => {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw refused();
    return ids.map(id => { const receipt = readGateReceipt(boardReceiptStore(board), id); if (!receipt) throw refused(); return receipt; });
  };
  const candidates = read(request.candidateReceiptIds);
  for (const receipt of candidates) board.enginePorts.boundProofReceipt(board, { receiptId: receipt.id });
  const config = submitGateConfig(policyAt(root, options.companion?.commit ?? options.commit).config, policy.config);
  const plan = submitGatePlan(root, config, { base: item.item_claim_head, trunk: options.policyCommit,
    check: frozenCheck(item), commit: options.companion?.commit ?? options.commit });
  const phases = plan.phases.map(({ role, command }) => ({ role, command: createHash('sha256').update(command).digest('hex') }));
  if (phases.length !== candidates.length || phases.some((phase, index) => phase.command !== candidates[index].command)
    || JSON.stringify(options.submissionProof?.files) !== JSON.stringify(plan.proofFiles)
    || options.submissionProof?.full !== plan.selection.full || options.submissionProof?.deferred !== plan.deferred
    || JSON.stringify(options.submissionProof?.deferredFiles ?? []) !== JSON.stringify(plan.deferSelection ? plan.selection.files : [])) throw refused();
  const sealed = { version: 1, signatureVersion: candidates.find(row => row.failureSignatures)?.failureSignatures.version, policy: { commit: options.policyCommit, enabled: true }, main: request.main,
    phases, candidates, comparisons: read(request.mainReceiptIds),
    runner: policy.config.affectedTests, lanes: policy.config.lanes };
  validateKnownMainAutofile(board, id, options, sealed);
  return { ...options, autoMainReds: sealed };
}

