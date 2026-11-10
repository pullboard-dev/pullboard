/**
 * The one criterion freezer the claim, refreeze, edit and spec moves hand the board [B2,C7,V4].
 *
 * It reads a checkout's root and config, never a CLI context, so the CLI and the cell test fixture
 * freeze a criterion the same way: same text, same digest. Why here: store.claim takes the freeze
 * as a callback, and the claim move is the cell that owns what a claim freezes.
 */
import { createHash } from 'node:crypto';
import { loadDoctrine } from '../../../doctrine/index.js';
import { agentDoctrine } from '../../../doctrine/index.js';
import { foreignNodeOptions } from '../../../gate/index.js';
import { headCommit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { verifiedPasskeyRowDecision } from '../../../person/index.js';
import { itemPolicy } from '../../../sandbox/index.js';
import { mainPolicy } from '../../../sandbox/index.js';
import { policyAt } from '../../../sandbox/index.js';
import { frozenCriterion } from '../../../spec/index.js';
import { loadSpec } from '../../../spec/index.js';
import { refuseAgentApprovedRows } from '../../../spec/index.js';
import * as store from '../../../store/index.js';
import { itemCheckBaseline } from '../../../store/index.js';
import { barCoverageCommand } from '../../../verify/index.js';
import { barCoverageForPolicy } from '../../../verify/index.js';
import { barReadiness } from '../../../verify/index.js';
import { barReadinessRequired } from '../../../verify/index.js';
import { machineVerification } from '../../../verify/index.js';
import { liveCriterionSpec } from '../../../doctrine/index.js';
import { mainCriterionFacts } from '../../../doctrine/index.js';

/**
 * Freeze a criterion from committed policy, refreshing trunk policy only on an explicit refreeze.
 *
 * @param {{ root: string, isMain: boolean, config: any }} checkout - the repository root, whether it is the main checkout, and its loaded config
 * @param {{ captureVerifyPolicy?: boolean, board?: any, applyingDecisions?: any[] }} [options]
 * @returns {(item: any) => { text: string, digest: string }}
 */
export function criterionFreezer({ root, isMain, config: checkoutConfig }, { captureVerifyPolicy = false, board, applyingDecisions = [] } = {}) {
  const cacheEligible = () => !foreignNodeOptions(process.env.NODE_OPTIONS);
  let doctrine;
  // agentDoctrine falls back to this checkout's own doctrine only when no main facts were read.
  const reader = { info: { root, isMain }, get doctrine() { return doctrine ??= loadDoctrine(root, checkoutConfig); } };
  /** Freeze the criterion and, when requested, the trunk lane and verifier policy. */
  return (item) => {
    // Derivation starts only inside the actual callback, after prepared claim guards [B2,C7].
    const readsMain = board && !(isMain && !headCommit(root));
    let sourcePolicy = null;
    if (readsMain) {
      try { sourcePolicy = mainPolicy(root); }
      catch (error) {
        if (!(error instanceof Refused) || error.code !== 'NO_POLICY') throw error;
        // A primary detached for review still has its retained accepted trunk; never use candidate rows as authority.
      }
    }
    const facts = readsMain ? mainCriterionFacts(root,
      { ...(sourcePolicy ? { commit: sourcePolicy.commit } : {}), cacheEligible }) : null;
    const prior = item.item_frozen ? JSON.parse(item.item_frozen) : null;
    const needsPinnedPolicy = !prior || captureVerifyPolicy;
    let policy = prior?.policy ?? null;
    if (needsPinnedPolicy && !(isMain && !headCommit(root))) {
      policy = { version: 1, commit: sourcePolicy?.commit ?? mainPolicy(root).commit };
    }
    let config;
    if (policy && needsPinnedPolicy) {
      const commit = /^[0-9a-f]{40,64}$/.test(policy.commit ?? '')
        ? policy.commit
        : (/^[0-9a-f]{40,64}$/.test(item.item_claim_head ?? '') ? item.item_claim_head : mainPolicy(root).commit);
      config = policyAt(root, commit).config;
      policy = { version: 1, commit, verify: { policy: config.verify.policy, family: config.verify.family,
        ...(Number.isSafeInteger(config.verify.familyRelaxAt) && config.verify.familyRelaxAt > 0 ? { familyRelaxAt: config.verify.familyRelaxAt } : {}) } };
    } else {
      config = policy ? itemPolicy(root, { ...item, item_frozen: JSON.stringify({ policy }) }).config : checkoutConfig;
    }
    // Only spec apply's already validated native decision events are being materialized now [S18,V2].
    const applying = new Map(applyingDecisions.map(record => [record.event, record]));
    const decisions = board ? store.rowDecisions(board).map(record => {
      const planned = applying.get(record.event);
      const exact = planned && ['kind', 'file', 'id', 'source', 'replacement', 'text', 'decision'].every(key => planned[key] === record[key]);
      return exact ? { ...record, applied: true } : record;
    }) : [];
    const rules = board ? agentDoctrine(reader, board, { facts, decisions }) : loadDoctrine(root, config);
    if (board) refuseAgentApprovedRows(root, { board, config: facts?.config ?? config, item }, { store, verifiedPasskeyRowDecision });
    const spec = board && facts ? liveCriterionSpec(root, facts, item, decisions) : loadSpec(root, config);
    const frozen = frozenCriterion(spec, item, rules);
    if (!policy) return frozen; // Legacy criteria retain their original digest and committed claim base.
    const signed = board && barReadinessRequired(board, item) ? barReadiness(board, item, {}, { itemCheckBaseline }).signed : null;
    const coverage = signed?.coverage ? barCoverageForPolicy(root, item, signed.coverage, { commit: policy.commit, config }) : null;
    const machine = board ? machineVerification(board, item) : null;
    const text = JSON.stringify({ ...JSON.parse(frozen.text), ...(machine ? { machineVerification: machine } : {}), ...(coverage ? { sourceCheck: item.item_check, check: barCoverageCommand(item.item_check, coverage), barCoverage: coverage, barRevision: signed.revision } : {}), policy });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
}
