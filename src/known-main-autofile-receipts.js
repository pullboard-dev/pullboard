/** Seal native receipt bytes and accepted opt-in before this submit can enter the event stream [V4,H16]. */
import { Refused } from './refused.js';
import { createHash } from 'node:crypto';
import { submitGatePlan, submitGateConfig } from './gate-submit.js';
import { frozenCheck } from './trusted-policy.js';
import { policyAt, mainPolicy } from './trusted-policy.js';
import { contains, tryGit } from './git.js';
import { readGateReceipt, boardReceiptStore } from './gate-run-receipt.js';
import { validateKnownMainAutofile } from './known-main-autofile.js';
/** Refuse missing origin evidence without widening generic creation authority. */
function refused() { return new Refused('SUBMISSION_PROOF', 'automatic Main red repairs need native evidence and accepted-main opt-in; rerun submit'); }

/** Seal actual gate-written receipts and accepted policy; caller-supplied receipt or setting bytes are never authority. */
export function sealKnownMainAutofile(board, id, options) {
  if (!options.autoMainReds) return options;
  const request = options.autoMainReds;
  const root = board.gitRoot;
  const policy = policyAt(root, options.policyCommit);
  if (!contains(root, options.policyCommit, mainPolicy(root).commit)
    || tryGit(root, ['merge-base', options.companion?.commit ?? options.commit, options.policyCommit]).stdout.trim() !== request.main) throw refused();
  if (policy.config.submit?.autoFileMainReds !== true) throw refused();
  const read = ids => {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw refused();
    return ids.map(id => { const receipt = readGateReceipt(boardReceiptStore(board), id); if (!receipt) throw refused(); return receipt; });
  };
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
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

