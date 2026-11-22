/**
 * One board rerun of a sharded gate's new reds: when every case a red gate fails is new against main (not a main red,
 * not unknown) and at most three files fail, the board offers one shard job for just those files before the red applies.
 * Why: a red only in files that load-flake on a busy runner went back to a builder whose seat was already gone, and the
 * next builder resubmitted the same commit; a rerun on a quieter moment settles it with no agent [C7,P7].
 */
import * as store from '../../../../store/index.js';
import { readPayload } from '../../../../jobs/index.js';
import { atomically } from '../../../../jobs/index.js';
import { noteLease } from '../../../../jobs/index.js';
import { createHash } from 'node:crypto';
import { offerJob } from '../jobs.js';
import { offeredRequest } from '../jobs.js';
import { SHARD_JOB_KIND } from '../jobs.js';
import { queueFor } from '../queue.js';

// Budget: a rerun is for a flake in a few files; a red wider than this is the item's own.
const RETRY_MAX_FILES = 3;

/** Quote one word for a shell, as the gate's planner quotes the files it names. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** The id of the one retry shard of a gate job. */
export function retryShardId(parent) {
  return `${parent}:shard:retry`;
}

/**
 * Offer the one retry shard of a red sharded gate.
 *
 * @param {any} board
 * @param {{ parent: string, combined: Record<string, any>, compared: { cases: { file: string, onMain: boolean | null }[] } | null }} input
 * @returns {{ retried: boolean }} retried is true only when this call offered the shard.
 */
export function retryNewReds(board, { parent, combined, compared }) {
  const cases = compared?.cases ?? [];
  const files = [...new Set(cases.map(row => row.file))];
  if (!cases.length || cases.some(row => row.onMain !== false) || !files.length || files.length > RETRY_MAX_FILES) return { retried: false };
  const { db } = board;
  if (queueFor(board, 'coordinator')) return { retried: false };
  const id = retryShardId(parent);
  if (db.prepare('SELECT 1 FROM job WHERE job_id = ?').get(id)) return { retried: false };
  const first = db.prepare("SELECT job_id, job_item, job_candidate, job_base FROM job WHERE job_kind = ? AND job_id LIKE ? ORDER BY job_created, job_id LIMIT 1").get(SHARD_JOB_KIND, `${parent}:shard:%`);
  const request = first ? offeredRequest(db, first.job_id) : null;
  const plan = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(parent);
  const runner = plan ? readPayload(db, plan.payload)?.receipt?.gate?.proofPlan?.runner : null;
  if (!request?.input?.data || typeof runner !== 'string' || !runner.trim()) return { retried: false };
  const offered = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(first.job_id);
  const needs = offered ? JSON.parse(offered.payload).needs ?? [] : [];
  const command = `${runner.trim()} ${files.map(file => shellWord('./' + file)).join(' ')}`;
  const { ledger, ...shard } = request.input.data.shard ?? {};
  offerJob(db, { id, kind: SHARD_JOB_KIND, priority: 'gate', needs, item: first.job_item, candidate: first.job_candidate, base: first.job_base,
    request: { ...request, input: { ...request.input, data: { ...request.input.data, shard: { ...shard, index: 1, of: 1, files, command } } } } });
  return { retried: true };
}

/** Append one note fact to the item a sharded gate was offered for, as the submitter, when the gate carries its submit. */
export function shardNote(board, offered, text) {
  if (offered?.submit) store.appendFact(board, offered.item, { agentId: offered.submit.agentId, kind: 'note', text });
}

/** Recover one unaccounted shard, or claim its existing settlement lease, through the same-cell gate readers. */
export function shardRecovery(board, input, readers = {}) {
  if (input.action === 'claim') return claimShardSettle(board.db, input.job, input.now, input);
  const { SHA, PROJECT_FILE, MAX_SHARDS, offeredGate, latestGateJob, postedReceipt, offeredStep, selectedShardContext, SHARDS_SETTLING } = readers;
  /** A single deterministic identity for replacing one incomplete native proof shard of a submitted gate. */
  const unknownShardId = (parent, index) => `${parent}:shard:unknown:${index}`;

  /** Whether a completed red proof phase has a complete named case account for ordinary main comparison. */
  function accountedShard(posted) {
    const gate = posted?.receipt?.gate;
    const phase = (gate?.phases ?? []).find(row => row.role === 'proof');
    return posted?.receipt?.status === 1 && gate?.green === false && !gate.error
      && gate.phases.length === 1 && !phase?.signal && !phase?.unreported && phase?.status === 1 && Array.isArray(phase.failures) && phase.failures.length > 0
      && phase.failures.every(row => typeof row?.name === 'string' && row.name && PROJECT_FILE.test(row?.file ?? ''));
  }

  /** Bind one replacement offer to the complete immutable request and native attempts of its original shard. */
  function unknownShardBinding(board, parent, parentPosted, source, sourcePosted, sourceOffer) {
    const parentOffer = offeredGate(board.db, parent);
    const parentRequest = offeredRequest(board.db, parent);
    const sourceRequest = sourceOffer?.request;
    const shard = sourceRequest?.input?.data?.shard;
    const sourceRow = board.db.prepare('SELECT job_kind, job_item, job_candidate, job_base FROM job WHERE job_id = ?').get(source);
    const parentRow = board.db.prepare('SELECT job_item FROM job WHERE job_id = ?').get(parent);
    const item = parentRow ? store.getItem(board, parentRow.job_item) : null;
    const tree = parentOffer?.submit?.companion?.tree ?? parentOffer?.submit?.tree ?? null;
    if (!parentOffer?.submit || !parentRequest || !sourceRequest || !shard || !sourceRow || !parentRow
      || latestGateJob(board.db, parentRow.job_item) !== parent || item?.item_status !== 'claimed'
      || item.item_owner !== parentOffer.submit.agentId || item.item_frozen_digest !== parentOffer.submit.digest
      || sourceRow.job_kind !== SHARD_JOB_KIND || sourceRow.job_item !== parentRow.job_item
      || !Number.isSafeInteger(parentPosted?.attempt) || parentPosted.attempt < 1
      || !Number.isSafeInteger(sourcePosted?.attempt) || sourcePosted.attempt < 1
      || !SHA.test(String(sourceRow.job_candidate ?? '')) || !SHA.test(String(sourceRow.job_base ?? '')) || !SHA.test(String(tree ?? ''))
      || sourceRequest.gate !== parent || sourceRequest.input?.data?.source !== sourceRow.job_candidate
      || JSON.stringify(sourceRequest.run) !== JSON.stringify(parentRequest.run)
      || JSON.stringify(sourceRequest.commits) !== JSON.stringify(parentRequest.commits ?? [])
      || sourceRequest.input?.entry !== parentRequest.input?.entry || sourceRequest.input?.main !== sourceRow.job_base
      || sourceRequest.input?.data?.main !== sourceRow.job_base || typeof shard.command !== 'string'
      || !Array.isArray(shard.files) || !shard.files.length || shard.files.some(file => !PROJECT_FILE.test(file))
      || !Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.of)
      || sourceRow.job_base !== parentOffer.main || parentRequest.input?.data?.source !== sourceRow.job_candidate
      || parentRequest.input?.data?.main !== sourceRow.job_base || parentPosted.receipt?.gate?.source !== sourceRow.job_candidate) return null;
    const requestDigest = createHash('sha256').update(JSON.stringify(sourceRequest)).digest('hex');
    return { parent, parentAttempt: parentPosted.attempt, original: source, originalAttempt: sourcePosted.attempt,
      candidate: sourceRow.job_candidate, main: sourceRow.job_base, tree, requestDigest };
  }

  /** A shard set is recoverable only when its original immutable offers cover the complete selected proof exactly once. */
  function unknownShardCandidate(board, parent, shards, parentPosted) {
    if (queueFor(board, 'coordinator')) return null;
    const gateReceipt = parentPosted?.receipt;
    const plan = gateReceipt?.gate?.proofPlan;
    if (!Array.isArray(plan?.files) || !plan.files.length || new Set(plan.files).size !== plan.files.length) return null;
    const prefix = `${parent}:shard:`;
    const originals = shards.filter(row => /^[1-9][0-9]*$/u.test(row.job_id.slice(prefix.length)));
    if (!originals.length || originals.length !== shards.length || originals.length > MAX_SHARDS || originals.some(row => row.job_step !== 'done')) return null;
    const indices = new Set();
    const allFiles = [];
    const parts = [];
    for (const row of originals) {
      const index = Number(row.job_id.slice(prefix.length));
      const posted = postedReceipt(board.db, row.job_id);
      const offer = offeredStep(board.db, row.job_id);
      const request = offer?.request;
      const selected = request?.input?.data?.shard;
      const receipt = posted?.receipt;
      const phase = (receipt?.gate?.phases ?? []).find(one => one.role === 'proof');
      const source = gateReceipt?.gate?.source;
      const identity = board.db.prepare('SELECT job_candidate, job_base FROM job WHERE job_id = ?').get(row.job_id);
      if (indices.has(index) || !posted || !Number.isSafeInteger(posted.attempt) || posted.attempt < 1 || !offer || !selected || selected.index !== index || selected.of !== originals.length
        || !Array.isArray(selected.files) || !selected.files.length || selected.files.some(file => !PROJECT_FILE.test(file))
        || selected.files.length !== new Set(selected.files).size || request.gate !== parent
        || identity?.job_candidate !== source || identity?.job_base !== gateReceipt.gate.main
        || request.input?.data?.source !== source || request.input?.data?.main !== identity.job_base
        || receipt?.gate?.kind !== 'shard' || receipt.gate?.source !== source || receipt.gate?.main !== request.input.data.main
        || receipt.gate?.shard?.index !== index || receipt.gate?.shard?.of !== selected.of
        || JSON.stringify(receipt.gate?.shard?.files) !== JSON.stringify(selected.files)) return null;
      indices.add(index);
      allFiles.push(...selected.files);
      parts.push({ row, posted, offer, selected, phase });
    }
    if (indices.size !== originals.length || [...indices].some(index => index > originals.length)
      || allFiles.length !== plan.files.length || new Set(allFiles).size !== allFiles.length
      || plan.files.some(file => !allFiles.includes(file))) return null;
    const unknown = parts.filter(({ posted, phase }) => posted.receipt?.status === 1
      && phase?.status === 1 && !accountedShard(posted));
    if (unknown.length !== 1 || parts.some(part => !unknown.includes(part)
      && !(part.posted.receipt?.status === 0 && part.posted.receipt.gate?.green === true && part.phase?.status === 0
        && part.posted.receipt.gate.phases.length === 1 && !part.posted.receipt.gate.error && !part.phase.signal && !part.phase.unreported)
      && !accountedShard(part.posted))) return null;
    const selected = unknown[0];
    const binding = unknownShardBinding(board, parent, parentPosted, selected.row.job_id, selected.posted, selected.offer);
    if (!binding || !Array.isArray(selected.offer.needs)) return null;
    return { ...selected, binding, id: unknownShardId(parent, selected.selected.index), parts };
  }

  /** Offer one normal, fresh shard job for the exact immutable selection; never alter or credit the original receipt. */
  function offerUnknownShardReplacement(board, parent, candidate, now) {
    if (board.db.prepare('SELECT 1 FROM job WHERE job_id = ?').get(candidate.id)) return false;
    const request = structuredClone(candidate.offer.request);
    request.input.data.shard.recovery = candidate.binding;
    offerJob(board.db, { id: candidate.id, kind: SHARD_JOB_KIND, priority: 'gate', needs: candidate.offer.needs,
      run: candidate.offer.run ?? [], item: board.db.prepare('SELECT job_item FROM job WHERE job_id = ?').get(candidate.row.job_id).job_item,
      candidate: candidate.binding.candidate, base: candidate.binding.main, request, now });
    return true;
  }

  /** Validate a completed replacement against its immutable original offer and both recorded source attempts. */
  function completedUnknownReplacement(board, parent, candidate, replacement) {
    const offer = offeredStep(board.db, replacement.job_id);
    const posted = postedReceipt(board.db, replacement.job_id);
    const recovery = offer?.request?.input?.data?.shard?.recovery;
    const request = offer?.request;
    const original = offeredStep(board.db, candidate.row.job_id);
    const row = board.db.prepare('SELECT job_kind, job_item, job_candidate, job_base FROM job WHERE job_id = ?').get(replacement.job_id);
    const parentRow = board.db.prepare('SELECT job_item FROM job WHERE job_id = ?').get(parent);
    if (!offer || !posted || !recovery || !row || !original || !parentRow || row.job_kind !== SHARD_JOB_KIND
      || row.job_item !== parentRow.job_item || row.job_candidate !== candidate.binding.candidate || row.job_base !== candidate.binding.main
      || JSON.stringify(recovery) !== JSON.stringify(candidate.binding) || recovery.parent !== parent
      || recovery.original !== candidate.row.job_id || recovery.originalAttempt !== candidate.posted.attempt
      || recovery.parentAttempt !== postedReceipt(board.db, parent)?.attempt) return { posted, accepted: false, reason: 'replacement-binding-mismatch' };
    const baseRequest = structuredClone(request);
    delete baseRequest.input.data.shard.recovery;
    if (createHash('sha256').update(JSON.stringify(baseRequest)).digest('hex') !== candidate.binding.requestDigest
      || JSON.stringify(offer.needs) !== JSON.stringify(candidate.offer.needs)
      || JSON.stringify(offer.run ?? []) !== JSON.stringify(candidate.offer.run ?? [])) return { posted, accepted: false, reason: 'replacement-selection-mismatch' };
    const receipt = posted.receipt;
    const gate = receipt?.gate ?? {};
    const phase = (gate.phases ?? []).find(one => one.role === 'proof');
    const selected = request.input.data.shard;
    if (gate.kind !== 'shard' || gate.source !== candidate.binding.candidate || gate.main !== candidate.binding.main
      || gate.shard?.index !== selected.index || gate.shard?.of !== selected.of
      || JSON.stringify(gate.shard?.files) !== JSON.stringify(selected.files)) return { posted, accepted: false, reason: 'replacement-receipt-mismatch' };
    if (gate.error || gate.analysis?.infra || gate.analysis?.refusals?.length || gate.analysis?.ownership
      || gate.phases?.length !== 1 || phase?.signal || phase?.unreported
      || !Number.isSafeInteger(posted.attempt) || posted.attempt < 1) return { posted, accepted: false, reason: 'replacement-incomplete' };
    const green = receipt.status === 0 && gate.green === true && phase?.status === 0;
    const red = receipt.status === 1 && gate.green === false && accountedShard(posted);
    return green || red ? { posted, accepted: true, green, reason: green ? 'replacement-complete-green' : 'replacement-complete-red' }
      : { posted, accepted: false, reason: 'replacement-incomplete' };
  }

  const { parent, shards, replacements, retry, now, mode } = input;
  let { parts } = input;
  let recovery = null;
    // Recovery is narrower than a case retry: one unaccounted original, every other original completely accounted.
    // Its immutable request pins trusted tooling and admission; normal postReceipt authenticates the new attempt.
    const candidate = !retry && mode === 'pull'
      ? unknownShardCandidate(board, parent, shards, postedReceipt(board.db, parent)) : null;
    if (candidate && !replacements.length && offerUnknownShardReplacement(board, parent, candidate, now)) {
      noteLease(board.db, parent, SHARDS_SETTLING, { released: true }, now);
      shardNote(board, offeredGate(board.db, parent), `Gate job ${parent}: replacement ${candidate.id} offered for original ${candidate.row.job_id}; reason: single-unaccounted-shard.`);
      return { parts, recovery, pending: { applied: false, outcome: 'recovering', original: candidate.row.job_id, replacement: candidate.id } };
    }
    if (replacements.length) {
      const replacement = replacements[0];
      const result = candidate && replacements.length === 1 && replacement.job_id === candidate.id
        ? completedUnknownReplacement(board, parent, candidate, replacement)
        : { accepted: false, reason: 'replacement-binding-mismatch' };
      recovery = { original: candidate?.row.job_id ?? null, replacement: replacement.job_id, reason: result.reason };
      if (result.accepted) {
        parts = parts.map(part => part.job === candidate.row.job_id
          ? { job: replacement.job_id, posted: result.posted, selected: selectedShardContext(board.db, replacement.job_id) } : part);
      }
    }

  return { parts, recovery };
}

// Budget: a settle claim a process holds this long without its settled note is a lost process's; the next claim takes it over [P7].
const SETTLING_LEASE_MS = 10 * 60_000;

/**
 * Claim the one apply of a sharded gate's result: in one immediate transaction, which serializes every process on the
 * board file, note it settling unless it is settled or another live claim holds it. True when this caller won.
 * Why: the apply ran before its settled note was written, so concurrent appliers each minted a submit admission and
 * only the first one's receipts were recorded; review then found no receipt after the newest admission (#10862) [C7,P7].
 */
function claimShardSettle(db, job, now, { SHARDS_SETTLED, SHARDS_SETTLING }) {
  return atomically(db, () => {
    const rows = db.prepare('SELECT job_step_name AS name, job_step_at AS at, job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name IN (?, ?)').all(job, `note:${SHARDS_SETTLED}`, `note:${SHARDS_SETTLING}`);
    if (rows.some(row => row.name === `note:${SHARDS_SETTLED}`)) return false;
    const held = row => row.name === `note:${SHARDS_SETTLING}` && !/"released":true/u.test(row.payload) && now - row.at < SETTLING_LEASE_MS;
    if (rows.some(held)) return false;
    noteLease(db, job, SHARDS_SETTLING, { pid: process.pid }, now);
    return true;
  });
}
