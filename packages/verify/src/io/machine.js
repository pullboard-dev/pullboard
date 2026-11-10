/** Coordinator authorization and machine verdicts use the same native board transaction as submission [V1,V4,H16]. */
import { machineBarDigest } from '../logic/verdict/machine.js';
import { machineClauseCommands } from '../logic/verdict/machine.js';
import { machineProofProblem } from '../logic/verdict/machine.js';
import { itemReviewPolicy } from '../logic/review/policy.js';
import { gateJudgmentPath } from './review/tier.js';
import { recordVerdict } from '../logic/verdict/assurance.js';
import { Refused } from '../../../kernel/index.js';
import { MOVES } from '../../../state/index.js';

/** Read the explicit authorization; default off and stale bars cannot inherit an old opt-in. */
export function machineVerification(board, item) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`machine_verification:${item.item_id}`);
  const value = row ? JSON.parse(row.meta_value) : null;
  return value?.enabled === true && value.bar === machineBarDigest(item) ? value : null;
}

/** Check permission before any file-backed clause command can become board authority. */
export function validateMachineVerification(board, item, { agentId, machineVerified, machineCommands }) {
  if (machineVerified === undefined && machineCommands === undefined) return;
  if (agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator marks an item machine-verified');
  if (typeof machineVerified !== 'boolean' || item.item_status !== 'open') throw new Refused('MACHINE_STATE', 'change machine verification only on an open item, using --machine-verified or --no-machine-verified');
  if (machineVerified) machineClauseCommands(item, machineCommands);
  else if (machineCommands !== undefined) throw new Refused('MACHINE_COMMANDS', 'commands accompany an enabled machine-verification mark');
}

/** Persist reversible authorization as visible event metadata, without changing any schema. */
export function saveMachineVerification(board, item, options) {
  if (options.machineVerified === undefined) return null;
  validateMachineVerification(board, item, options);
  const value = { version: 1, enabled: options.machineVerified, bar: machineBarDigest(item),
    commands: options.machineVerified ? machineClauseCommands(item, options.machineCommands) : [] };
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`machine_verification:${item.item_id}`, JSON.stringify(value));
  return value;
}

/** Strict policy and sensitive source paths always retain independent review, even under a Standard default. */
export function machineVerificationEligible(board, item, files) {
  const frozen = item.item_frozen ? JSON.parse(item.item_frozen) : null;
  const authorization = machineVerification(board, item);
  if (!authorization || JSON.stringify(frozen?.machineVerification) !== JSON.stringify(authorization)) return null;
  const policy = itemReviewPolicy(board, item.item_id);
  if (policy.tier === 'strict' || policy.sensitive || [...files, ...(item.item_files ?? '').split('\n')].some(gateJudgmentPath)) return null;
  return authorization;
}

/** Validate sealed receipts and record an explicit machine acceptance after the normal submit guards pass. */
export function acceptMachineSubmission(board, item, options, { getItem, moveItem, logEvent }) {
  const authorization = machineVerificationEligible(board, item, options.files ?? []);
  if (!authorization) return false;
  if (item.item_status !== 'submitted' || item.item_merged_commit || item.item_commit !== options.commit || item.item_tree !== options.tree) {
    throw new Refused('MACHINE_PROOF', 'machine acceptance binds the current unlanded submitted source only');
  }
  const problem = machineProofProblem(item, authorization, options.machineReceipts, { commit: options.commit, tree: options.tree,
    main: options.policyCommit, seat: options.agentId, frozenCheck: JSON.parse(item.item_frozen).check });
  if (problem) throw problem;
  const commands = [{ clause: 0, command: JSON.parse(item.item_frozen).check }, ...authorization.commands]
    .map((command, index) => ({ ...command, receipt: options.machineReceipts[index].id }));
  const note = `machine-verified: ${commands.map(row => `${row.clause ? `clause ${row.clause}` : 'frozen check'}: ${row.command} (receipt ${row.receipt})`).join('; ')}`;
  // All ordinary submit guards have just passed. This transition substitutes native command evidence for agent judgment.
  moveItem(board, item.item_id, 'accept', {
    checks: Object.fromEntries(MOVES.find(move => move.verb === 'accept').guards.map(name => [name, null])),
    before: found => recordVerdict(board, found, { agentId: 'coordinator', decision: 'ACCEPT', reason: 'CRITERION_MET', note,
      digest: found.item_frozen_digest, head: options.commit }),
    set: () => ({ item_verdict: 'ACCEPT', item_verified_by: 'coordinator' }),
  });
  const review = { commit: options.commit, head: options.commit, trunk: options.policyCommit, paths: [...new Set(options.files ?? [])].sort() };
  logEvent(board, 'coordinator', 'accept', item.item_id, { reason: 'CRITERION_MET', commit: options.commit, note, check: 'green', review,
    machine: { version: 1, commands }, environment: options.machineReceipts[0].proof.environment });
  return getItem(board, item.item_id);
}
