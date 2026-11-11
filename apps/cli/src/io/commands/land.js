import { landingFlakeRatchet } from '../../../../../packages/flakes/index.js';
import { landBatch } from '../../../../../packages/land/index.js';
import { driveLanding } from '../../../../../packages/drive/index.js';
import { inProcessLandingBatch } from '../../../../../packages/landing/index.js';
import { landingProgress } from '../../../../../packages/landing/index.js';
import { landingFailureObservation } from '../../../../../packages/health/index.js';
import { PHASE_LINE } from '../../../../../packages/landing/index.js';
import { scheduleAutomaticLanding } from '../../../../../packages/landing/index.js';
import { closeLandingSpans } from '../../../../../packages/resources/index.js';
import { landingSpan } from '../../../../../packages/resources/index.js';
import { openLandingSpans } from '../../../../../packages/resources/index.js';
import { replayLanding } from '../../../../../packages/landing/index.js';
import { replayLine } from '../../../../../packages/landing/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { adoptLocalSession } from '../../../../../packages/seats/index.js';
import { localSeatSessionDigest } from '../../../../../packages/seats/index.js';
import { existsSync } from 'node:fs';
import { automaticLandingEnabled } from '../../../../../packages/merge/index.js';
import { landAcceptedItems } from '../../../../../packages/merge/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { requireManualLanding } from '../../../../../packages/merge/index.js';
import { flakeLedger } from '../../../../../packages/flakes/index.js';
import { badgeCounts } from '../../../../view/index.js';
import { writeBadges } from '../../../../view/index.js';
import { flakeSource } from '../../../../../packages/flakes/index.js';
import { observeNativeFailure } from '../../../../../packages/flakes/index.js';
import { quarantineWaivers } from '../../../../../packages/flakes/index.js';
import { quarantineVerdictSnapshot } from '../../../../../packages/flakes/index.js';
import { validateQuarantineGate } from '../../../../../packages/flakes/index.js';
import { validateQuarantineLandingProof } from '../../../../../packages/flakes/index.js';
import { gateRuns } from '../../../../../packages/flakes/index.js';
import { postLandSuitePorts } from '../ports/suite.js';
import { parseProcessCensus } from '../../../../../packages/kernel/index.js';
import { fileURLToPath } from 'node:url';
import { codeIsFromMain } from '../../../../../packages/git/index.js';
import { syncRelay } from '../../../../../packages/link/index.js';
/** The pullboard land command, in its own module so an item adding another command never edits these lines. */
import { landWhy } from '../../../../../packages/landing/index.js';
import { landWhyLines } from '../../../../../packages/landing/index.js';
import { withBoardRead } from '../board/read.js';
import { context } from '../read.js';
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
} from '../../../../../packages/gate/index.js';
import {
  land,
} from '../../../../../packages/landing/index.js';
import {
  agentSessionDigest,
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  requireSignedPerson,
} from '../../../../../packages/person/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  staleVerdictRefusal,
} from '../../../../../packages/verify/index.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  actOn,
  ordered,
} from '../entry.js';

/** Run `pullboard land` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values.why) {
    const ctx = context(io);
    const why = await withBoardRead(ctx, (board) => landWhy(board, ctx.clock.now()));
    if (values.json) io.result(why);
    else for (const line of landWhyLines(why)) io.say(line);
    return 0;
  }
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  if (values.replay) {
    if (first || second || rest.length || values.due || values.adopt || values['dry-run'] || values.waive !== undefined || values.max !== undefined) throw new Refused('USAGE', 'pullboard land --replay [--since <time>] takes no other option');
    const rows = replayLanding(board, { since: values.since });
    io.result?.({ replay: rows });
    for (const row of rows) io.say(replayLine(row));
    if (!rows.length) io.say('no recorded landing batches to replay');
    return 0;
  }
  if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator lands verified batches; ask your coordinator to run pullboard land');
  // A signed person's waiver and the coordinator's named landing stay open while the board owns landing [#3675,#5559].
  const named = values.items !== undefined || values.commit !== undefined ? namedLanding(ctx.info.root, values) : null;
  if (values.waive === undefined && !named) requireManualLanding(mainPolicy(ctx.info.root).config);
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
  const result = await executeBoardLanding(ctx, board, io, values, named);
  return !values['dry-run'] && !result.landed?.length && result.culprits?.length ? 1 : 0;
});
}

/**
 * Read `--items 1,2 --commit <sha>,<sha>` into the named landing: each item with the proven commit it lands as.
 * Why: the coordinator lands work proven outside the board's verify step (the blitz lander's job) through the same
 * train as any landing, so the lease, guards, detached worktree and compare-and-swap of main apply to it too [C7,#5559].
 *
 * @param {string} root
 * @param {Record<string, unknown>} values - The parsed options.
 * @returns {{ id: number, commit: string }[]}
 */
function namedLanding(root, values) {
  const usage = 'pullboard land --items <id>[,<id>...] --commit <sha>[,<sha>...] [--dry-run]; one commit per item, in order, and no other landing option';
  if (typeof values.items !== 'string' || typeof values.commit !== 'string' || values.adopt || values.due || values.replay || values.waive !== undefined || values.max !== undefined) throw new Refused('USAGE', usage);
  const ids = values.items.split(',');
  const commits = values.commit.split(',');
  if (ids.length !== commits.length || ids.some(id => !/^[1-9][0-9]*$/u.test(id)) || new Set(ids).size !== ids.length) throw new Refused('USAGE', usage);
  return ids.map((id, index) => {
    const resolved = tryGit(root, ['rev-parse', '--verify', '--quiet', `${commits[index]}^{commit}`]);
    if (resolved.status !== 0 || !resolved.stdout.trim()) throw new Refused('LAND_NAMED', `commit ${commits[index]} for item #${id} is not a commit in this repository`, 'fetch it or name its full sha');
    return { id: Number(id), commit: resolved.stdout.trim() };
  });
}

/**
 * Write a landed batch through the land cell's finish sequence, the one `pullboard merged` also runs, so the landing
 * job and its tooling pin exist for every landing. The batch is already recorded, so a failure here is reported and
 * never changes the landing's result.
 *
 * @param {object} ctx
 * @param {object} board
 * @param {object} io
 * @param {{ batch?: object }} result - The batch engine's result.
 * @returns {Promise<void>}
 */
async function recordBatchLanding(ctx, board, io, result) {
  try { await landBatch(board.db, { repo: ctx.info.root, batch: result?.batch, owner: `land:${agentSessionDigest() ?? `pid-${process.pid}`}` }); }
  catch (error) { io.err?.(`landing job deferred: ${error.code ?? 'ERROR'} ${error.message}`); }
}

/**
 * The in-process batch runner `land` uses in place of the spawned bin/landing-worker.js, composed with the same
 * runner check and candidate worker the worker process composed.
 *
 * Why: the runner cell is imported only when a real landing runs, so every other board command stays fast. The
 * batch reports its progress to `progress`, which the landing's drive job watches (#3477).
 *
 * @param {ReturnType<typeof landingProgress>} progress - The batch's progress record.
 * @returns {Promise<Function>}
 */
async function landingBatchRunner(progress) {
  const { checkAtCommit } = await import('../../../../runner/index.js');
  return inProcessLandingBatch({ checkAtCommit, candidateWorkerFile: fileURLToPath(new URL('../../../../lib/src/io/landing/candidate.js', import.meta.url)), progress });
}

/**
 * Hand an interrupted landing batch's worktree to the coordinator session that adopts it (GH #24).
 * Why: the batch's merges ran under the first session, whose digest the worktree's own checkout-session file still
 * held; after `takeover` in the main checkout, `land --adopt` merged there and was refused NOT_YOUR_CHECKOUT, and
 * `takeover` cannot run in a landing worktree, which has no lane. The file is replaced only while it still holds the
 * coordinator binding read here, under the worktree's lease, so a session that bound it meanwhile is never overwritten.
 *
 * @param {object} board
 * @param {string} root the main checkout
 */
async function rebindAdoptedLanding(board, root) {
  const digest = agentSessionDigest();
  const batch = store.landingBatches(board).findLast((entry) => entry.state !== 'landed' && entry.state !== 'blocked');
  if (!digest || !batch?.root || !existsSync(batch.root)) return;
  const info = repoInfo(batch.root);
  if (info.root === root) return;
  const from = localSeatSessionDigest(info, COORDINATOR);
  if (from && from !== digest) await adoptLocalSession(info, { agent: COORDINATOR, digest, from: { agent: COORDINATOR, digest: from } });
}

/** Compose the existing native batch engine for both automatic acceptance and an authorized manual command. */
export async function executeBoardLanding(ctx, board, io, values = {}, named = null) {
  if (!values['dry-run'] && codeIsFromMain()) {
    const afterEventId = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    await (await import('../../../../../packages/gate/index.js')).activateMainAudits(ctx.info.root, afterEventId, store.boardId(board));
  }
  const owner = agentSessionDigest() ?? `pid-${process.pid}`;
  if (values.adopt && !values['dry-run']) await rebindAdoptedLanding(board, ctx.info.root);
  // The repository's landing.stall: how long a batch may make no progress before it ends (10 minutes unset, #3186, #3477).
  const progress = landingProgress();
  const watch = { stallAfterMs: ctx.config?.landing?.stallMs, lastProgressAt: progress.lastProgressAt, stall: progress.stall };
  /** One landing through the batch engine; a real one runs in this process as a drive-cell job [C7]. */
  const landOnce = async () => land({ landingPorts: { badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns, landingFlakeRatchet, postLandSuite: postLandSuitePorts() }, root: ctx.info.root, board,
    runBatch: values['dry-run'] ? undefined : await landingBatchRunner(progress),
    write: (operation, parameters) => untilBoardFree(() => ordered(ctx, board, operation, parameters), { say: line => io.err?.(line) }), refresh: () => syncRelay(ctx.info.root, io), say: line => (PHASE_LINE.test(line) ? io.err?.(line) : io.say(line)), owner,
    ...(named ? { named } : {}), maximum: values.max === undefined ? Infinity : Number(values.max), dryRun: Boolean(values['dry-run']), adopt: Boolean(values.adopt), automatic: values.automatic === true, due: Boolean(values.due), onWait: io.gateWaitReporter(io) });
  let result;
  // A real landing records a span per step, read back by pullboard gate-health [C7].
  if (!values['dry-run']) openLandingSpans({ commonDir: ctx.info.commonDir });
  try { result = values['dry-run'] ? await landOnce() : await driveLanding(board.db, { owner, run: () => landingSpan('run', landOnce), say: line => io.err?.(line), watch });
  } catch (error) {
    await recordLandingNotices(ctx, board, io);
    throw error;
  } finally { if (!values['dry-run']) closeLandingSpans(); }
  if (!values['dry-run']) await recordLandingNotices(ctx, board, io);
  if (!values['dry-run']) await recordBatchLanding(ctx, board, io, result);
  io.result?.(result);
  for (const blocked of result.blocked ?? []) if (blocked.code === 'STALE_VERDICT') io.say(staleVerdictRefusal({ item_id: blocked.id }, blocked).message);
  if (!result.batch && !result.deferredUntil && !result.cadence) io.say(result.items ? `would land: ${result.items.map((id) => `#${id}`).join(', ') || 'none'}` : 'no verified items ready to land');
  return result;
}


/**
 * How long an accept's landing wake waits before it starts: none, so the lander starts the accepted item's landing at
 * once (the scheduler's own 1 s floor still applies). Why: a 10 s wait to gather accepts into one batch was a batching
 * delay, and batches hold one item (Corey 5 Nov); accepts made while a landing runs still go to that one worker [C7].
 */
export const LANDING_COALESCE_MS = 0;

/**
 * Run board-owned landing after acceptance; the caller catches this entire post-verdict effect.
 * An agent session hands landing to the board's own worker: the main checkout belongs to the coordinator's session,
 * so landing there from a reviewer's session was refused NOT_YOUR_CHECKOUT and nothing landed (#2499). The worker
 * holds no session, and one pending wake absorbs every accept made before it fires. Returns true, or the landing's
 * result when this process ran it.
 */
export async function landAfterAcceptance(ctx, { schedule = scheduleAutomaticLanding, session = agentSessionDigest, now = Date.now } = {}) {
  if (!mainCheckout(ctx.info.root)?.branch || !automaticLandingEnabled(mainPolicy(ctx.info.root).config)) return false;
  const root = primaryCheckoutRoot(ctx.info);
  if (session()) {
    await schedule(root, new Date(now() + LANDING_COALESCE_MS).toISOString(), new URL('../landing/automatic.js', import.meta.url));
    ctx.io.say?.('the board lands this accept from the main checkout shortly; no command is needed there');
    return true;
  }
  const io = { ...ctx.io, cwd: root, result: undefined, relayCommand: undefined, requestedCommand: undefined, personRequest: undefined, personRequestMoveId: undefined };
  let reopened = 0;
  const result = await actOn(io, async (landing, board) => {
    const policy = mainPolicy(root);
    const items = store.listItems(board, { all: true }).filter(item => item.item_status === 'verified' && !item.item_merged_commit)
      .map(item => ({ id: item.item_id, commit: store.checkedLandingCommit(board, item) }));
    const landed = await landAcceptedItems({ root, config: policy.config, trunk: policy.commit, items,
      reopen: (id, conflict, note) => {
        const item = store.getItem(board, id);
        if (item.item_status !== 'verified' || item.item_merged_commit) return null;
        reopened += 1;
        return untilBoardFree(() => ordered(landing, board, 'reopen', [id, { agentId: 'coordinator', ...(conflict ? { conflict } : { withdrawVerdict: true }), note: note ?? `landing conflict: ${conflict.files.join(', ')}; merge current main and resubmit` }]), { say: line => ctx.io.err?.(line) });
      },
      execute: () => executeBoardLanding(landing, board, io, { automatic: true }) });
    return { ...(landed && typeof landed === 'object' ? landed : {}), retryMs: policy.config.landing?.cadenceMs ?? LANDING_RETRY_MS,
      reopened, waiting: store.listItems(board, { all: true }).some(item => item.item_status === 'verified' && !item.item_merged_commit && !item.item_hold_at),
      untried: untriedAfter(store.listItems(board, { all: true }), landed?.batch) };
  });
  const retryAt = landingRetryAt(result, now());
  if (retryAt) await schedule(root, retryAt, new URL('../landing/automatic.js', import.meta.url));
  // The wake reads the run's outcome, so a blocked batch with untried work waiting starts the next run at once [C7].
  return result && typeof result === 'object' ? result : true;
}

/**
 * Whether a verified, unheld, unmerged item waits outside a batch that just ended blocked: work the next batch can take
 * at once. Why: after each blocked batch the lander backed off 1 to 4 minutes while #3862, never tried, waited [C7].
 *
 * @param {object[]} items - The board's items.
 * @param {object | undefined} batch - The batch this run ended with.
 * @returns {boolean}
 */
export function untriedAfter(items, batch) {
  if (batch?.state !== 'blocked') return false;
  const tried = new Set((batch.items ?? batch.candidates ?? []).map(entry => entry.id));
  return items.some(item => item.item_status === 'verified' && !item.item_merged_commit && !item.item_hold_at && !tried.has(item.item_id));
}

/** How long a landing waits before trying again while verified items still wait, when no cadence is set [C7]. */
export const LANDING_RETRY_MS = 30_000; // 5 min idled the lander after every blocked batch while 60 items waited [C7].

/** How soon the next batch starts after a run that landed or reopened items while others still wait [C7]. */
export const LANDING_NEXT_BATCH_MS = 1_000;

/**
 * Run one board write, waiting out a busy board lock with doubling backoff instead of ending the landing. Only the
 * refused write repeats, never the batch work before it. Why: board write locks are held for seconds (5.3 s at most
 * over 400 writes on 4 Nov), yet a BOARD_BUSY ended the landing and left accepted work idle until the next cycle; any
 * other refusal still ends the attempt (#3149).
 */
export async function untilBoardFree(work, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {}, pauseMs = 1_000, maxPauseMs = 8_000, maxWaitMs = 120_000 } = {}) {
  for (let waited = 0, pause = pauseMs; ; pause = Math.min(pause * 2, maxPauseMs)) {
    try { return await work(); }
    catch (error) {
      // A stale flake-ratchet boundary is not a lock: the same snapshot can never be accepted while seats keep
      // writing, so the worker must recompute it (prepareFlakeLanding), not sleep; 2 minutes of sleeping ended a
      // worker and cost #3167 a second gate on 6 Nov [C7].
      if (error?.code !== 'BOARD_BUSY' || /flake evidence or repair status changed/u.test(error.message ?? '') || waited + pause > maxWaitMs) throw error;
      say(`landing met a busy board lock; waiting ${Math.round(pause / 1000)} s and continuing the same landing`);
      await wait(pause);
      waited += pause;
    }
  }
}

/**
 * When the board's next landing wake is due: within seconds after a run that moved work, else a recorded deferral, else one retry interval from now while verified,
 * unheld items are still waiting; null when nothing waits [C7,#2898].
 * Why: only an accept scheduled a landing, so a blocked batch left verified work idle until the next accept.
 */
export function landingRetryAt(result, now) {
  if (!result?.waiting) return null;
  // A run that moved work (landed it, or reopened a conflict or culprit) starts the next batch at once while verified
  // items wait, ahead of any deferral: the lander sat idle about 65% of the time waiting a full interval after every
  // landing (#3149). A run that moved nothing keeps its deferral or the interval, so a refusal that stays put never
  // loops hot.
  // A batch that ended blocked tried its items; the next batch takes the untried ones behind it at once [C7].
  const moved = result?.stalled === true || result?.landed?.length > 0 || result?.conflicts?.length > 0 || result?.culprits?.length > 0 || result?.reopened > 0
    || result?.batch?.state === 'blocked' && result.untried === true;
  if (moved && result.waiting) return new Date(now + LANDING_NEXT_BATCH_MS).toISOString();
  if (result?.deferredUntil) return result.deferredUntil;
  return result?.waiting ? new Date(now + (result.retryMs ?? LANDING_RETRY_MS)).toISOString() : null;
}

/**
 * Use the existing ordered health move so a refusal reaches the inbox without a new replay effect. A notice never
 * blocks or repeats a landing: a HEALTH_SCAN_STALE refusal (the board moved between the read and the move) reads
 * the observation again once, and any other failure is logged and dropped, as on 9 Nov [C7].
 */
async function recordLandingNotices(ctx, board, io) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const observation = landingFailureObservation(board);
      if (observation) await ordered(ctx, board, 'recordHealthFindings', [{ agentId: 'coordinator', ...observation }]);
      return;
    } catch (error) {
      if (error?.code === 'HEALTH_SCAN_STALE' && attempt === 0) continue;
      io.err?.('landing refusal notice deferred: ' + (error.code ?? 'ERROR'));
      return;
    }
  }
}
