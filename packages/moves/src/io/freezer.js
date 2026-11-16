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
import { tryGit } from '../../../git/index.js';
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
import { namedTestHashes } from '../../../verify/index.js';
import { wording } from '../../../verify/index.js';
import { machineVerification } from '../../../verify/index.js';
import { liveCriterionSpec } from '../../../doctrine/index.js';
import { admittedPace } from '../logic/pace.js';
import { mainCriterionFacts } from '../../../doctrine/index.js';

/**
 * A reader of repository files as committed at one commit.
 * Why: the frozen test hashes cover committed content, never a dirty working file, read the same way at claim and at submit [C7,V4].
 *
 * @param {string} root a checkout of the repository
 * @param {string | null} commit the commit to read; null reads nothing
 * @returns {(path: string) => string | null} file text, or null when the file is absent at that commit
 */
export function committedReader(root, commit) {
  return path => {
    if (!commit) return null;
    const shown = tryGit(root, ['show', `${commit}:${path}`]);
    return shown.status === 0 ? shown.stdout : null;
  };
}

/**
 * Freeze the bar alone: title, criterion, check and cited spec rows, never pullboard.json [B4,R2].
 *
 * Why: a pinned policy commit went stale with every policy change and stranded items NO_POLICY; policy is
 * read live per move instead. A bar frozen by the previous release keeps its pinned policy text (N-1).
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
  /** Freeze the criterion; captureVerifyPolicy now only means a refreeze, which drops a legacy policy pin. */
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
    // Only a bar frozen by the previous release still carries a pinned policy; it keeps reproducing it so its
    // digest reads and verifies unchanged (N-1). Every new freeze, and every refreeze, is the bar alone [B4,R2].
    const legacy = !captureVerifyPolicy && prior?.policy ? prior.policy : null;
    const config = legacy ? itemPolicy(root, { ...item, item_frozen: JSON.stringify({ policy: legacy }) }).config : checkoutConfig;
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
    const signed = board && barReadinessRequired(board, item) ? barReadiness(board, item, {}, { itemCheckBaseline }).signed : null;
    const coverageCommit = legacy?.commit ?? (signed?.coverage ? sourcePolicy?.commit ?? mainPolicy(root).commit : null);
    const coverage = signed?.coverage ? barCoverageForPolicy(root, item, signed.coverage, { commit: coverageCommit, config: legacy ? config : policyAt(root, coverageCommit).config }) : null;
    const machine = board ? machineVerification(board, item) : null;
    // The named test files' content hashes come from accepted main at claim, and a bar already frozen keeps exactly the
    // hashes it has through every later recompute, so a landing on main never moves the digest; only a refreeze or a
    // changed criterion hashes again [C7,V4].
    const fresh = captureVerifyPolicy || !prior || wording(prior.criterion) !== wording(JSON.parse(frozen.text).criterion);
    const testHashes = namedTestHashes({ item_frozen: frozen.text }, fresh ? committedReader(root, sourcePolicy?.commit ?? headCommit(root)) : () => null, fresh ? {} : prior.testHashes ?? {});
    const hashed = Object.keys(testHashes).length > 0;
    // The pace is read once, at the first claim, and every later freeze keeps it; steady records nothing [V2].
    const pace = admittedPace(prior, facts?.config ?? checkoutConfig);
    if (!legacy && !machine && !coverage && !hashed && !pace) return frozen;
    const text = JSON.stringify({ ...JSON.parse(frozen.text), ...(pace ? { pace } : {}), ...(hashed ? { testHashes } : {}), ...(machine ? { machineVerification: machine } : {}), ...(coverage ? { sourceCheck: item.item_check, check: barCoverageCommand(item.item_check, coverage), barCoverage: coverage, barRevision: signed.revision } : {}), ...(legacy ? { policy: legacy } : {}) });
    return { text, digest: createHash('sha256').update(text).digest('hex') };
  };
}
