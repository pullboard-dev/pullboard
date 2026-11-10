/** Publish only exact native independent review coverage, never a PR author's proof claims [B3,R3]. */
import { refuseGrafts } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { readProofGraph } from './graph.js';
import { capturePrProof } from '../../logic/snapshot.js';

export const PR_VERIFICATION_CONTEXT = 'pullboard/verified-by-second-agent';
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Unknown historical provenance or a different criterion cannot become independent proof later. */
function itemReceipt(snapshot, item) {
  if (item.item_status !== 'verified' || item.item_verdict !== 'ACCEPT') return null;
  const verdict = snapshot.accepted.get(item.item_id), assurance = snapshot.assurance(verdict);
  if (!verdict || assurance !== 'independent' || verdict.check !== 'green'
      || verdict.verdict_digest !== item.item_frozen_digest || verdict.verdict_by === item.item_built_by
      || verdict.review?.commit !== item.item_commit || !COMMIT.test(verdict.review?.head ?? '')
      || !verdict.environment || ['platform', 'arch', 'node'].some(key => typeof verdict.environment[key] !== 'string' || !verdict.environment[key])) return null;
  return { item: item.item_id, commit: item.item_commit, reviewer: verdict.verdict_by,
    verdict: verdict.verdict_id, assurance, checked: verdict.review.head };
}

/** Resolve actual native landings and companions using only the single exact graph captured for this pass. */
function coverage(snapshot, receipts, graph, commits, trustedHead) {
  const items = new Map(snapshot.items.map(item => [item.item_id, item]));
  const recorded = [...new Set([...snapshot.items.map(item => item.item_merged_commit),
    ...snapshot.batches.filter(batch => ['trunk', 'landed', 'pushed'].includes(batch.state)).map(batch => batch.tip)])]
    .filter(commit => COMMIT.test(commit ?? '') && graph.isAncestor(commit, trustedHead));
  const trunks = new Set(recorded), maximal = graph.maximal(recorded);
  const covered = new Map([...receipts.values()].map(receipt => [receipt.commit, receipt]));
  for (const item of snapshot.items) {
    const commit = item.item_merged_commit, receipt = receipts.get(item.item_id), node = graph.nodes.get(commit);
    if (receipt && trunks.has(commit) && node?.item === item.item_id && node.parents.length > 1
        && graph.isAncestor(receipt.commit, commit)) {
      for (const introduced of graph.range(node.parents[0], commit)) covered.set(introduced, receipt);
    }
  }
  for (const commit of commits) {
    const companion = receipts.get(graph.nodes.get(commit)?.companion);
    const landed = companion && items.get(companion.item)?.item_merged_commit;
    if (companion && COMMIT.test(landed ?? '') && maximal.some(trunk =>
      graph.isAncestor(commit, trunk) && graph.isAncestor(landed, trunk))) covered.set(commit, companion);
  }
  return covered;
}

/** Preserve the existing procedural-receipt explanation without fresh SQL or exporting private notes. */
function unverifiedReason(snapshot, commits) {
  const selected = new Set(commits);
  for (const item of snapshot.items.filter(item => selected.has(item.item_commit))) {
    const verdict = snapshot.accepted.get(item.item_id), assurance = verdict && snapshot.assurance(verdict);
    if (verdict && assurance !== 'independent') return "second agent's independence is unproven (" + (assurance ?? 'unknown') + ')';
  }
  return 'one or more commits lack an exact independent green receipt';
}

/** Collect provider ranges without giving an outside PR authority from a description or shared head. */
function preparePull(snapshot, client, pull, proposal, repository) {
  const head = pull.head?.sha;
  const outside = snapshot.items.find(item => {
    const source = snapshot.outside.get(item.item_id);
    return source?.repository === repository && source.kind === 'pull-request' && source.number === pull.number && source.commit === head;
  });
  if (!(proposal && proposal.head === head) && !outside) return { pull,
    failure: { state: 'failure', description: 'not verified: outside pull request; use pullboard intake', assurance: 'unknown', receipts: [] } };
  if (!COMMIT.test(head ?? '') || !COMMIT.test(pull.base?.sha ?? '')) return { pull,
    failure: { state: 'failure', description: 'not verified: exact pull request range is unavailable', assurance: 'unknown', receipts: [] } };
  // Larger ranges are resolved in the shared graph, never a separate Git process per PR.
  const rows = pull.commits <= 250 ? client.commits(pull.number) : null;
  return { pull, commits: rows ? rows.map(row => row.sha) : null };
}

/** Capture one receipt cohort and one Git graph for every PR, with no process-global proof cache. */
function verificationPass({ root, board, client, entries, repository, trustedHead }) {
  refuseGrafts(root);
  const snapshot = capturePrProof(board);
  const receipts = new Map(snapshot.items.map(item => [item.item_id, itemReceipt(snapshot, item)]).filter(([, receipt]) => receipt));
  const prepared = entries.map(({ pull, proposal }) => preparePull(snapshot, client, pull, proposal, repository));
  const endpoints = [trustedHead, ...snapshot.items.map(item => item.item_merged_commit),
    ...snapshot.batches.map(batch => batch.tip), ...[...receipts.values()].map(receipt => receipt.commit),
    ...prepared.flatMap(entry => entry.failure ? [] : [entry.pull.head.sha, entry.pull.base.sha, ...(entry.commits ?? [])])];
  const graph = readProofGraph(root, endpoints);
  for (const entry of prepared) if (!entry.failure && entry.commits === null) {
    entry.commits = graph.nodes.has(entry.pull.base.sha) && graph.nodes.has(entry.pull.head.sha)
      ? graph.range(entry.pull.base.sha, entry.pull.head.sha) : [];
  }
  const covered = coverage(snapshot, receipts, graph,
    [...new Set(prepared.flatMap(entry => entry.commits ?? []))], trustedHead);
  return prepared.map(entry => {
    if (entry.failure) return entry.failure;
    const { pull, commits } = entry;
    if (!Number.isSafeInteger(pull.commits) || pull.commits < 1 || commits.length !== pull.commits
        || commits.some(commit => !COMMIT.test(commit ?? '')) || new Set(commits).size !== commits.length
        || !commits.includes(pull.head.sha) || commits.some(commit => !graph.isAncestor(commit, pull.head.sha))) {
      return { state: 'failure', description: 'not verified: complete exact commit range is unavailable', assurance: 'unknown', receipts: [] };
    }
    const missing = commits.filter(commit => !covered.has(commit));
    if (missing.length) return { state: 'failure', description: 'not verified: ' + unverifiedReason(snapshot, missing),
      assurance: 'unproven', receipts: [], unverified: missing };
    return { state: 'success', description: 'verified by a second agent (independent)', assurance: 'independent',
      receipts: [...new Map(commits.map(commit => { const receipt = covered.get(commit); return [receipt.verdict, receipt]; })).values()] };
  });
}

/** Check one complete provider range against the same native/graph interpretation used by a publish pass. */
export function pullRequestVerification(options) {
  return verificationPass({ ...options, entries: [{ pull: options.pull, proposal: options.proposal }] })[0];
}

/** Validate exact open PR identities before publication can create or update proposal branches. */
export function verificationPulls(client, state, repository) {
  const numbers = [...new Set([...client.open().map(pull => pull.number),
    ...state.proposals.filter(proposal => proposal.repository === repository).map(proposal => proposal.number)])];
  return numbers.map(number => {
    if (!Number.isSafeInteger(number) || number < 1) throw new Refused('PUBLISH_GITHUB', 'the pull request lacks an exact provider identity; refresh it before publishing');
    const pull = client.read(number);
    if (pull.number !== number || !COMMIT.test(pull.head?.sha ?? '')) throw new Refused('PUBLISH_GITHUB', 'the pull request lacks an exact head; refresh it before publishing');
    return { pull, proposal: state.proposals.find(entry => entry.repository === repository && entry.number === pull.number) };
  });
}

/** Reconcile every open PR using one coverage pass, keeping commit-level provider statuses conservative. */
export function publishVerificationStatuses({ root, board, client, state, repository, trustedHead }) {
  const entries = verificationPulls(client, state, repository);
  const verification = verificationPass({ root, board, client, entries, repository, trustedHead });
  const results = entries.map(({ pull, proposal }, index) => ({ number: pull.number, head: pull.head.sha, ...verification[index],
    ...(proposal ? {} : { intake: `pullboard intake https://github.com/${repository}/pull/${pull.number} --criterion "behavior" --check "command"` }) }));
  // GitHub statuses belong to a commit, not a PR: an outside PR sharing a head must never borrow green.
  for (const head of new Set(results.map(result => result.head))) {
    const sharing = results.filter(result => result.head === head);
    const red = sharing.find(result => result.state !== 'success');
    const status = { state: red ? 'failure' : 'success', context: PR_VERIFICATION_CONTEXT,
      description: red?.description ?? 'verified by a second agent (independent)' };
    const old = client.statuses(head).find(entry => entry.context === status.context);
    if (!old || old.state !== status.state || old.description !== status.description) client.setStatus(head, status);
    for (const result of sharing) { result.statusState = status.state; result.statusDescription = status.description; }
  }
  return results;
}
