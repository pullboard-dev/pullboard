import { receiptBlockingGreen } from "../../../verify/index.js";
/** A late worker cannot reopen a new submission, bar, patch set or review episode [C7,V4,H16]. */
import { Refused } from "../../../kernel/light.js";

/** Preserve ordinary reopen authority while additionally binding its autonomous measured cause. */
export function sourceAdvanceReturnProblem(board, item, request) {
  const proof = request.sourceAdvanceReturn;
  const stale = board.nativePorts.sourceAdvanceCASProblem(board, item, proof);
  if (stale) return stale;
  const validFiles = Array.isArray(proof.files) && proof.files.length > 0 && proof.files.length <= 4096
    && proof.files.every(path => typeof path === 'string' && path && !path.startsWith('/') && !/[\\\r\n\0]/u.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..'));
  if (!validFiles || proof.version !== 1 || request.agentId !== 'coordinator'
    || request.note !== proof.action?.note || JSON.stringify(request.conflict) !== JSON.stringify(proof.action?.conflict)
    || request.quotedLandingFailure !== proof.action?.quotedLandingFailure) {
    return new Refused('SOURCE_ADVANCE_PROOF', 'the automatic return must retain its exact measured cause and named files');
  }
  if (proof.outcome === 'conflict' && JSON.stringify(proof.action.conflict) === JSON.stringify({ files: proof.files, trunk: proof.trunk })
    && Array.isArray(proof.phases) && proof.phases.length === 0) return null;
  if (proof.outcome === 'red' && Array.isArray(proof.phases) && proof.phases.length === 1) {
    const receipt = board.runtimePorts.sourceAdvanceReceipts.receiptFields(proof.phases[0]?.receipt);
    const held = receipt?.blockingVerdict?.quarantines ?? [];
    const failures = receipt?.failures?.filter(failure => !held.some(row => row.file === failure.file && row.name === failure.name)) ?? [];
    try { if (receipt) board.nativePorts.quarantine.validateQuarantineVerdict(board, receipt); }
    catch { return new Refused('SOURCE_ADVANCE_PROOF', 'the measured red needs current quarantine event references'); }
    if (receipt?.version === 2 && receipt.kind === 'submit' && receipt.head === proof.head && receipt.tree === proof.tree && receipt.main === proof.trunk
      && receipt.proof.item === item.item_id && receipt.proof.seat === 'coordinator' && receipt.proof.frozenDigest === proof.bar
      && receipt.proof.sourceClean && !receiptBlockingGreen(receipt) && receipt.green === false && receipt.proof.exitCode !== null && receipt.proof.exitCode !== 0
      && receipt.proof.counts.failed > 0 && failures.length > 0
      && JSON.stringify([...new Set(failures.map(row => row.file))].sort()) === JSON.stringify(proof.files)) return null;
  }
  return new Refused('SOURCE_ADVANCE_PROOF', 'unknown infrastructure is incomplete; returning work requires actual conflict or named red evidence');
}
