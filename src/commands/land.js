import { landingFlakeRatchet } from '../../packages/flakes/index.js';
import { landingFailureObservation } from '../../packages/health/index.js';
import { scheduleAutomaticLanding } from '../../packages/landing/index.js';
import { mainCheckout } from '../../packages/git/index.js';
import { automaticLandingEnabled } from '../../packages/merge/index.js';
import { landAcceptedItems } from '../../packages/merge/index.js';
import { primaryCheckoutRoot } from '../cli/worktree.js';
import { mainPolicy } from '../../packages/sandbox/index.js';
import { requireManualLanding } from '../../packages/merge/index.js';
import { flakeLedger } from '../../packages/flakes/index.js';
import { badgeCounts } from '../../apps/view/index.js';
import { writeBadges } from '../../apps/view/index.js';
import { flakeSource } from '../../packages/flakes/index.js';
import { observeNativeFailure } from '../../packages/flakes/index.js';
import { quarantineWaivers } from '../../packages/flakes/index.js';
import { quarantineVerdictSnapshot } from '../../packages/flakes/index.js';
import { validateQuarantineGate } from '../../packages/flakes/index.js';
import { validateQuarantineLandingProof } from '../../packages/flakes/index.js';
import { gateRuns } from '../../packages/flakes/index.js';
import { postLandSuitePorts } from '../post-land-suite-ports.js';
import { parseProcessCensus } from '../../packages/kernel/src/core/process-census.js';
import { fileURLToPath } from 'node:url';
import { codeIsFromMain } from '../git.js';
import { syncRelay } from '../../packages/link/index.js';
/** The pullboard land command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  COORDINATOR,
} from '../../packages/config/index.js';
import {
  gateWaitReporter,
} from '../../packages/gate/index.js';
import {
  land,
} from '../../packages/landing/index.js';
import {
  agentSessionDigest,
  requirePersonChannel,
} from '../../packages/person/index.js';
import {
  requireSignedPerson,
} from '../../packages/person/index.js';
import {
  Refused,
} from '../../packages/kernel/index.js';
import {
  staleVerdictRefusal,
} from '../../packages/verify/index.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  actOn,
  ordered,
} from '../cli.js';

/** Run `pullboard land` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator lands verified batches; ask your coordinator to run pullboard land');
  requireManualLanding(mainPolicy(ctx.info.root).config);
  if (first || second || rest.length || values.due && (values.adopt || values.waive !== undefined || values.max !== undefined)) throw new Refused('USAGE', 'pullboard land [--max N] [--dry-run] [--adopt] | land --due [--dry-run] | land --waive <test> --until <date> --reason "why"; --due cannot combine with --max, --adopt or --waive');
  if (values.waive !== undefined) {
    const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'land-waive', args: { waive: String(values.waive), until: String(values.until ?? ''), reason: String(values.reason ?? '') } });
    if (confirmed !== null) return confirmed;
    requirePersonChannel(io.personChannel);
    const waiver = await ordered(ctx, board, 'recordLandingWaiver', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal',
      id: randomUUID(), test: values.waive, until: values.until, reason: values.reason }]);
    io.result?.({ batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], waiver });
    io.say(`waived ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test} until ${waiver.until}: ${waiver.reason}`);
    return 0;
  }
  if (values.until !== undefined || values.reason !== undefined || values.max !== undefined && (!/^[1-9][0-9]*$/u.test(values.max) || !Number.isSafeInteger(Number(values.max)))) throw new Refused('USAGE', 'use --max with a positive item count, or --waive with --until and --reason');
  await executeBoardLanding(ctx, board, io, values);
  return 0;
});
}

/** Compose the existing native batch engine for both automatic acceptance and an authorized manual command. */
export async function executeBoardLanding(ctx, board, io, values = {}) {
  if (!values['dry-run'] && codeIsFromMain()) {
    const afterEventId = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    await (await import('../../packages/gate/index.js')).activateMainAudits(ctx.info.root, afterEventId, store.boardId(board));
  }
  let result;
  try { result = await land({ landingPorts: { badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns, landingFlakeRatchet, postLandSuite: postLandSuitePorts() }, root: ctx.info.root, board,
    landingWorkerFile: fileURLToPath(new URL('../../bin/landing-worker.js', import.meta.url)),
    write: (operation, parameters) => ordered(ctx, board, operation, parameters), refresh: () => syncRelay(ctx.info.root, io), say: io.say, owner: agentSessionDigest() ?? `pid-${process.pid}`,
    maximum: values.max === undefined ? Infinity : Number(values.max), dryRun: Boolean(values['dry-run']), adopt: Boolean(values.adopt), automatic: values.automatic === true, due: Boolean(values.due), onWait: gateWaitReporter(io) });
  } catch (error) {
    await recordLandingNotices(ctx, board, io);
    throw error;
  }
  if (!values['dry-run']) await recordLandingNotices(ctx, board, io);
  io.result?.(result);
  for (const blocked of result.blocked ?? []) if (blocked.code === 'STALE_VERDICT') io.say(staleVerdictRefusal({ item_id: blocked.id }, blocked).message);
  if (!result.batch && !result.deferredUntil && !result.cadence) io.say(result.items ? `would land: ${result.items.map((id) => `#${id}`).join(', ') || 'none'}` : 'no verified items ready to land');
  return result;
}


/** How long an accept's landing wake waits, so accepts made together coalesce into one landing [B35]. */
export const LANDING_COALESCE_MS = 10_000;

/**
 * Run board-owned landing after acceptance; the caller catches this entire post-verdict effect.
 * An agent session hands landing to the board's own worker: the main checkout belongs to the coordinator's session,
 * so landing there from a reviewer's session was refused NOT_YOUR_CHECKOUT and nothing landed (#2499). The worker
 * holds no session, and one pending wake absorbs every accept made before it fires.
 */
export async function landAfterAcceptance(ctx, { schedule = scheduleAutomaticLanding, session = agentSessionDigest, now = Date.now } = {}) {
  if (!mainCheckout(ctx.info.root)?.branch || !automaticLandingEnabled(mainPolicy(ctx.info.root).config)) return false;
  const root = primaryCheckoutRoot(ctx.info);
  if (session()) {
    await schedule(root, new Date(now() + LANDING_COALESCE_MS).toISOString(), new URL('../../bin/automatic-landing.js', import.meta.url));
    ctx.io.say?.('the board lands this accept from the main checkout shortly; no command is needed there');
    return true;
  }
  const io = { ...ctx.io, cwd: root, result: undefined, relayCommand: undefined, requestedCommand: undefined, personRequest: undefined, personRequestMoveId: undefined };
  const result = await actOn(io, async (landing, board) => {
    const policy = mainPolicy(root);
    const items = store.listItems(board, { all: true }).filter(item => item.item_status === 'verified' && !item.item_merged_commit)
      .map(item => ({ id: item.item_id, commit: store.checkedLandingCommit(board, item) }));
    return landAcceptedItems({ root, config: policy.config, trunk: policy.commit, items,
      reopen: (id, conflict, note) => {
        const item = store.getItem(board, id);
        if (item.item_status !== 'verified' || item.item_merged_commit) return null;
        return ordered(landing, board, 'reopen', [id, { agentId: 'coordinator', ...(conflict ? { conflict } : { withdrawVerdict: true }), note: note ?? `landing conflict: ${conflict.files.join(', ')}; merge current main and resubmit` }]);
      },
      execute: () => executeBoardLanding(landing, board, io, { automatic: true }) });
  });
  if (result?.deferredUntil) {
    await schedule(root, result.deferredUntil, new URL('../../bin/automatic-landing.js', import.meta.url));
  }
  return true;
}

/** Use the existing ordered health move so a refusal reaches the inbox without a new replay effect. */
async function recordLandingNotices(ctx, board, io) {
  try {
    const observation = landingFailureObservation(board);
    if (observation) await ordered(ctx, board, 'recordHealthFindings', [{ agentId: 'coordinator', ...observation }]);
  } catch (error) { io.err?.('landing refusal notice deferred: ' + (error.code ?? 'ERROR')); }
}
