/** Find the repository a file-backed board belongs to, from where its file lives [C7]. */
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { appendFact } from './fact.js';
import { getItem } from './query.js';
import { contains } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { boundProofReceipt } from '../receipts.js';
import {
  basename,
  dirname,
  join,
} from 'node:path';

/**
 * The repository root of a board file stored the way Pullboard stores it, `<root>/.git/pullboard/<file>`, or null for
 * any other place. Why: a board opened without its repository used to refuse a submit with NO_POLICY, and the only fix
 * was to reopen it; the file's own location already names the repository, so the board rebinds itself instead.
 *
 * @param {string} file
 * @returns {string | null}
 */
export function repositoryOfBoardFile(file) {
  if (typeof file !== 'string' || !file) return null;
  const folder = dirname(file);
  const git = dirname(folder);
  if (basename(folder) !== 'pullboard' || basename(git) !== '.git') return null;
  const root = dirname(git);
  return existsSync(join(git, 'HEAD')) ? root : null;
}

/** Retry one policy operation against the repository named by this board's own file, only after NO_POLICY. */
export function withBoardRepositoryPolicy(board, operation) {
  try { return operation(); }
  catch (error) {
    if (error?.code !== 'NO_POLICY') throw error;
    const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    const root = repositoryOfBoardFile(file);
    if (!root) throw error;
    board.gitRoot = root;
    return operation();
  }
}

/** Seal against refreshed board custody once; a genuine changed-policy refusal still propagates on the retry. */
export function sealClauseInspection(board, id, options) {
  if (options.machineReceiptIds !== undefined || options.machineReceipts !== undefined) {
    if (!Array.isArray(options.machineReceiptIds)) throw new Refused('MACHINE_PROOF', 'native machine receipt ids are required');
    options = { ...options, machineReceipts: options.machineReceiptIds.map(receiptId => boundProofReceipt(board, { receiptId })) };
  }
  return withBoardRepositoryPolicy(board, () => sealCurrentClauseInspection(board, id, options));
}

/** Name changed policy leaves without treating object key order as policy. */
function changedPolicyKeys(before, after, prefix) {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .flatMap(key => changedPolicyKeys(before[key], after[key], `${prefix}.${key}`));
  }
  return [prefix];
}

/**
 * Bind clause inspection to the coordinator's accepted main, not a submitter's machine or arguments.
 *
 * The proof's policy commit may trail current main: landings move main during every long check, so a
 * forward move whose pullboard.json policy is unchanged keeps the sealed policy; any changed field refuses [V4].
 */
function sealCurrentClauseInspection(board, id, options) {
  if (!board.gitRoot) {
    const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (!file) return options; // Isolated in-memory fixtures have no board policy.
    throw new Refused('NO_POLICY', 'the native board must know its repository before submitting');
  }
  const root = board.gitRoot;
  const policy = board.enginePorts.sandboxPolicyReads.mainPolicy(root);
  const moved = Boolean(options.policyCommit && options.policyCommit !== policy.commit);
  // Main moving forward during a long proof is routine; only a rewind or a policy change voids the sealed policy (#2375).
  if (moved && !contains(root, options.policyCommit, policy.commit)) {
    throw new Refused('NO_POLICY', 'accepted main no longer contains the submit policy commit; refresh the submit policy and retry');
  }
  const sealed = moved ? board.enginePorts.sandboxPolicyReads.policyAt(root, options.policyCommit) : policy;
  const changed = [...new Set([...Object.keys(sealed.config), ...Object.keys(policy.config)])].sort()
    .flatMap(key => changedPolicyKeys(sealed.config[key], policy.config[key], key));
  let item = null;
  try { item = getItem(board, id); } catch (error) { if (error?.code !== 'NO_ITEM') throw error; }
  const lanePrefix = item ? `lanes.${item.item_lane}` : null;
  const relevant = ['shared', 'verify', 'gate', 'affectedTests', 'staticChecks', 'submitGate', 'submitInvariants',
    'landingShards', 'submitDeferAbove', 'check', 'checks'];
  const affecting = changed.filter(key => (lanePrefix && (key === lanePrefix || key.startsWith(`${lanePrefix}.`)))
    || relevant.some(name => key === name || key.startsWith(`${name}.`)));
  if (affecting.length) throw new Refused('NO_POLICY', `accepted submit policy changed: ${affecting.join(', ')}; refresh and retry`);
  if (changed.length && item?.item_owner === options.agentId) {
    const digest = config => createHash('sha256').update(JSON.stringify(config, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest('hex');
    appendFact(board, id, { agentId: options.agentId, kind: 'note',
      text: `policy re-frozen automatically: ${digest(sealed.config)} -> ${digest(policy.config)}; only ${changed.join(', ')} changed` });
  }
  return { ...options, clausePolicyCommit: sealed.commit, inspectClauses: sealed.config.verify.inspectClauses === true };
}
