import { boardWriteSnapshot } from '../../../../store/index.js';
import { requireBoardWriteSnapshot } from '../../../../store/index.js';
/** Ordered exact-source completion never changes the original submission or its review [C7,V4,H16]. */
import {
  sourceAdvanceReviewEpisode,
} from '../../../../verify/index.js';
import {
  atomic,
} from '../../../../store/index.js';
import {
  logEvent,
} from '../../../../store/index.js';
import {
  itemById,
} from '../../../../store/index.js';
import {
  itemPatchDigest,
} from '../../../../items/index.js';
import {
  receiptFields,
} from '../../../../verify/index.js';
import {
  ENGINE_VERSION,
} from '../../../../state/index.js';
import {
  SOURCE_ADVANCE_ENGINE,
} from '../../../../state/light.js';
import {
  sourceAdvanceChain,
} from '../../../../verify/index.js';
import {
  sourceAdvanceEpisode,
} from '../../../../verify/index.js';
import {
  acceptedVerdict,
} from '../../../../verify/index.js';
import {
  Refused,
} from '../../../../kernel/index.js';
import {
  frozenCheck,
} from '../trusted/policy.js';
import {
  sealSourceAdvance,
} from './advance/origin.js';
import {
  receiptBlockingGreen,
} from '../../../../verify/index.js';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HASH = /^[0-9a-f]{64}$/u;

/** Bind a worker to the latest immutable acceptance, or the still-unreviewed submission. */
export function sourceAdvanceVerdict(board, item) {
  if (item.item_status !== 'verified') return null;
  const latest = acceptedVerdict(board, item);
  if (!latest || latest.withdrawn || latest.verdict_digest !== item.item_frozen_digest
    || (latest.companionDigest ?? null) !== itemPatchDigest(board, item.item_id)) {
    throw new Refused('SOURCE_ADVANCE_STALE', 'the original verdict or its exact patch set changed; read the current item');
  }
  return latest;
}

/** Compare one immutable native episode before changing source or returning a failed composition. */
export function sourceAdvanceCASProblem(board, item, proof) {
  const verdict = sourceAdvanceVerdict(board, item);
  const previous = sourceAdvanceChain(board, item).at(-1)?.head ?? verdict?.review?.head ?? item.item_commit;
  return proof && ['submitted', 'verified'].includes(item.item_status) && !item.item_merged_commit
    && proof.board === board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value
    && proof.submitted === item.item_commit && proof.status === item.item_status && proof.bar === item.item_frozen_digest
    && proof.reviewEpisode === sourceAdvanceReviewEpisode(board, item.item_id)
    && proof.reviewBy === item.item_review_by && proof.reviewUntil === item.item_review_until
    && proof.patchDigest === itemPatchDigest(board, item.item_id) && proof.episode === sourceAdvanceEpisode(board, item.item_id)
    && proof.verdict === (verdict?.verdict_id ?? null) && proof.previous === previous ? null
    : new Refused('SOURCE_ADVANCE_STALE', 'the submitted source, acceptance, bar, patches or source-advance episode changed during the check');
}

/** Validate sealed receipt bytes and native CAS fields without receiver-local Git or clocks. */
export function sourceAdvanceProblem(board, item, proof) {
  const stale = sourceAdvanceCASProblem(board, item, proof);
  if (stale) return stale;
  const chain = sourceAdvanceChain(board, item);
  const verdict = sourceAdvanceVerdict(board, item);
  if (proof.version !== 1 || !['submitted','previous','inputHead','head','tree','trunk','mergeTree'].every(key => SHA.test(proof[key] ?? ''))
    || proof.head === proof.previous || !HASH.test(proof.bar ?? '') || !HASH.test(proof.selectionDigest ?? '')
    || !Array.isArray(proof.paths) || proof.paths.length > 100000
    || proof.paths.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || /[\r\n\0]/u.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..'))
    || JSON.stringify(proof.paths) !== JSON.stringify([...new Set(proof.paths)].sort())) {
    return new Refused('SOURCE_ADVANCE_PROOF', 'restore exact source identities, selected paths and proof phase bindings');
  }
  if (chain.length >= 32 && chain.at(-1)?.verdict === (verdict?.verdict_id ?? null)) return new Refused('SOURCE_ADVANCE_LIMIT', 'obtain a fresh independent review before extending this bounded source-advance chain');
  if (!Array.isArray(proof.phases) || proof.phases.length < 1 || proof.phases.length > 2
    || new Set(proof.phases.map(phase => phase.role)).size !== proof.phases.length
    || !proof.phases.some(phase => phase.role === 'affected')
    || Boolean(frozenCheck(item).trim()) !== proof.phases.some(phase => phase.role === 'criterion')) {
    return new Refused('SOURCE_ADVANCE_PROOF', 'the worker must retain the frozen check and the complete affected-test execution');
  }
  const ids = new Set();
  for (const phase of proof.phases) {
    const receipt = receiptFields(phase.receipt);
    if (!['criterion','affected'].includes(phase.role) || !HASH.test(phase.command ?? '') || !receipt
      || receipt.version !== 2 || receipt.kind !== 'submit' || receipt.command !== phase.command
      || receipt.head !== proof.head || receipt.tree !== proof.tree || receipt.main !== proof.trunk
      || !receiptBlockingGreen(receipt) || !receipt.proof.sourceClean
      || receipt.proof.item !== item.item_id || receipt.proof.seat !== 'coordinator'
      || receipt.proof.frozenDigest !== proof.bar || ids.has(receipt.id)) {
      return new Refused('SOURCE_ADVANCE_PROOF', 'the exact clean composition needs genuine green gate receipts for every required phase');
    }
    try { board.nativePorts.quarantine.validateQuarantineVerdict(board, receipt); }
    catch { return new Refused('SOURCE_ADVANCE_PROOF', 'the computed phase verdict needs current exact quarantine event references'); }
    ids.add(receipt.id);
  }
  return null;
}

/** Atomically append one source advance; old receipt UUID retries are idempotent even after main changes. */
export function advanceItemSource(board, id, request) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < SOURCE_ADVANCE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before recording a source advance');
  if (request?.agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the autonomous coordinator worker records checked main merges');
  if (!board.db.prepare("SELECT 1 FROM agent WHERE agent_id='coordinator'").get()) throw new Refused('NOT_JOINED', 'join the coordinator before recording a source advance');
  const snapshot = board.executionEngineVersion === undefined ? boardWriteSnapshot(board) : null;
  const proof = board.executionEngineVersion === undefined ? sealSourceAdvance(board, id, request).proof : request.proof;
  return atomic(board, () => {
    if (snapshot) requireBoardWriteSnapshot(board, snapshot, 'source advance');
    if (snapshot) board.runtimePorts.sourceAdvanceReceipts.guardLandingWrite(board, request?.landingFence);
    const item = itemById(board, id);
    const stored = sourceAdvanceChain(board, item);
    const prior = stored.find(entry => entry.head === proof?.head);
    if (prior) {
      const { eventId, ...body } = prior;
      if (JSON.stringify(body) !== JSON.stringify(proof)) throw new Refused('SOURCE_ADVANCE_STALE', 'that effective head already names different source-advance evidence');
      return { head: prior.head, eventId, changed: false };
    }
    const problem = sourceAdvanceProblem(board, item, proof);
    if (problem) throw problem;
    const event = logEvent(board, request.agentId, 'source_advanced', id, proof);
    const retained = stored.at(-1)?.verdict === proof.verdict ? stored : [];
    const chain = [...retained, { ...proof, eventId: event.event_id }];
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(`item_source_advance:${id}`, JSON.stringify({ version: 1, chain }));
    return { head: proof.head, eventId: event.event_id, changed: true };
  });
}
