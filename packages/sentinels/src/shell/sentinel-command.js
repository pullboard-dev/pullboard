import { warnIdleReady } from './idle-ready-warn.js';
import { wakeReviewCapacity } from './review-capacity-wake.js';
import { shoutConflictedReviews } from "../../../health/index.js";
import { specApprovalBaselineExists } from "../../../store/index.js";
import { relayRecovered } from "../../../link/index.js";
import { prepareStaleObservation } from "../../../health/index.js";
import { sweepClaims } from "../../../health/index.js";
import { refreshCapacityOutsideWrite } from "../../../verify/index.js";
import { atomic } from "../../../store/index.js";
import { dispatchWork } from "../../../store/index.js";
import { listAgents } from "../../../store/index.js";
import { withLocalSeatPresence } from "../../../store/index.js";
import { checkpointBoard } from "../../../store/index.js";
import { planStaleState } from "../../../../src/board-stale-state-maintenance.js";
import { releaseGoneClaims } from "../core/gone-claims.js";
/** CLI proposal and exact person decisions for board-owned watches [A6,D3]. */
import { PERSON } from "../../../store/index.js";
import {
  requireSignedPerson,
  signsPersonMoves,
} from "../../../person/index.js";
import { requirePersonChannel } from "../../../person/index.js";
import { Refused } from "../../../kernel/index.js";
import { dueSentinels } from "./sentinels.js";
import { sentinels } from "./sentinels.js";
import { runDueSentinels } from "./sentinel-runner.js";
import { withSentinelTrunk } from "./sentinel-runner.js";
import { healthSentinelEnabled } from "../../../config/index.js";
import { recordedHealthFindings } from "./health-sentinel.js";
import { scanHealthSentinel } from "./health-sentinel.js";
import { initialSpecApprovalBaseline } from "../../../spec/index.js";

/** The watch command's existing string options, shared with the CLI parser. */
export const SENTINEL_OPTIONS = {
  every: { type: 'string' },
  owner: { type: 'string' },
  directory: { type: 'string' },
  timeout: { type: 'string' },
  next: { type: 'string' },
  sentinel: { type: 'boolean' },
  'health-only': { type: 'boolean' },
};

/** Resume reports due watches in one line and never starts their commands. */
export function resumeSentinels({ ctx, withBoard }) {
  if (!healthSentinelEnabled(ctx.config)) return;
  return withBoard(ctx, board => {
    if (dueSentinels(board).length) ctx.io.say('Sentinels are due; schedule pullboard sentinel run to run them in a prepared trunk checkout.');
  });
}

/** Scan health, then run due approved watches on pinned trunk unless the observer requests health only. */
async function runSentinels({ ctx, withBoard, whoAmI, ordered, parseProcessCensus, sweepSubmitHandoffs, stalledGateDrives, healthOnly = false }) {
  // Dead submit workers end before the board scan, so the sweep never reports a gate as running with no worker (#2627).
  await sweepSubmitHandoffs?.();
  return withBoard(ctx, async board => {
    const me = whoAmI(ctx, board);
    await releaseGoneClaims(ctx, board, me, ordered);
    // Claim checks that read other seats' worktrees run here, off every command's path (#2427).
    await sweepClaims(ctx, board, me.id, ordered);
    // The capacity forecast and the WAL checkpoint run here too, never inside a move's write lock (#2578).
    refreshCapacityOutsideWrite(board, atomic);
    checkpointBoard(board.db);
    if (me.id === 'coordinator') {
      const snapshot = await prepareStaleObservation(ctx, board, ordered, { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists });
      const plan = planStaleState(snapshot);
      if (plan.holdWarnings.length || plan.holdExpiries.length || plan.reviewReleases.length) {
        await ordered(ctx, board, 'maintainStaleState', [{ agentId: me.id, snapshot, health: ctx.config.health ?? {} }]);
      }
    }
    const enabled = healthSentinelEnabled(ctx.config);
    if (enabled) {
      // Preserve bootstrap-before-observation ordering so the compatibility move cannot stale the scan.
      const baseline = initialSpecApprovalBaseline(ctx, board, 'recordHealthFindings', { relayRecovered: (root, options) => relayRecovered(root, options, ctx.io), specApprovalBaselineExists });
      if (baseline) {
        const io = ctx.io.personRequest || ctx.io.personRequestMoveId
          ? { ...ctx.io, personRequest: undefined, personRequestMoveId: undefined } : ctx.io;
        await ordered({ ...ctx, io }, board, 'recordSpecApprovalBaseline', [{ agentId: 'coordinator', baseline }]);
      }
      const observation = scanHealthSentinel(ctx.file, { root: ctx.info.root, config: ctx.config, now: ctx.clock.now(), returnRejected: me.id === 'coordinator',
        ...(stalledGateDrives ? { gateDrives: stalledGateDrives } : {}) });
      if (observation) {
        try { await ordered(ctx, board, 'recordHealthFindings', [{ agentId: me.id, ...observation }]); }
        catch (error) { if (!(error instanceof Refused) || error.code !== 'HEALTH_SCAN_STALE') throw error; }
      }
    }
    if (enabled && me.id === 'coordinator' && ctx.info.isMain) { await wakeReviewCapacity(ctx, board, ordered); await shoutConflictedReviews(ctx, board, ordered); }
    if (enabled && me.id === 'coordinator' && ctx.info.isMain) await warnIdleReady(ctx, board, ordered, { listAgents, withLocalSeatPresence, dispatchWork });
    const health = recordedHealthFindings(board);
    if (healthOnly || !enabled || !dueSentinels(board).length) {
      ctx.io.result?.({ sentinels: [], health });
      ctx.io.say(healthOnly ? 'Health scan complete; approved watches require an explicit pullboard sentinel run.' : 'No enabled sentinel is due.');
      return 0;
    }
    const { results, trunk } = await withSentinelTrunk(ctx.info.root, root => runDueSentinels({ root, board, agentId: me.id, parseProcessCensus,
      ordered: (operation, args) => ordered(ctx, board, operation, args) }));
    ctx.io.result?.({ sentinels: results, trunk, health });
    ctx.io.say(`Sentinels: ${results.length} run from trunk ${trunk.branch}@${trunk.commit.slice(0, 12)}.`);
    for (const row of results) ctx.io.say(`${row.name}: ${row.lastRun.green ? 'green' : 'red'}; owner ${row.owner}`);
    return 0;
  });
}

/**
 * Keep command parsing separate from the CLI's process and server setup. `stalledGateDrives(db, now)` is the drive
 * cell's detector for gate drives that renew their lease with no step; the health scan shouts each as Stuck.
 */
export async function sentinelCommand({ ctx, words, values, withBoard, whoAmI, ordered, parseProcessCensus, sweepSubmitHandoffs, stalledGateDrives }) {
  const [verb, name, ...extra] = words;
  if (verb === 'run' && !name && !extra.length) return runSentinels({ ctx, withBoard, whoAmI, ordered, parseProcessCensus, sweepSubmitHandoffs, stalledGateDrives, healthOnly: Boolean(values['health-only']) });
  if (extra.length || !['propose', 'approve', 'decline'].includes(verb) || !name) {
    throw new Refused('USAGE', 'use pullboard sentinel run, sentinel propose <name> --check "<command>" --every 10m --owner <seat or lane>, sentinel approve <name>, sentinel decline <name> --reason "<why>", or pullboard sentinels');
  }
  if (verb !== 'propose' && !signsPersonMoves(ctx.info.root)) requirePersonChannel(ctx.io.personChannel);
  return withBoard(ctx, async board => {
    const me = whoAmI(ctx, board);
    let row;
    if (verb === 'propose') {
      row = await ordered(ctx, board, 'proposeSentinel', [{ agentId: me.id, row: {
        name, check: values.check, every: values.every, owner: values.owner,
        directory: values.directory, timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout), next: values.next,
      } }]);
    } else {
      if (!ctx.info.isMain || me.id !== 'coordinator') throw new Refused('B26_PERSON_APPROVAL', 'only the person from the main checkout approves or declines a sentinel; use their terminal or Pullboard View');
      const current = sentinels(board).find(entry => entry.name === name);
      if (!current) throw new Refused('STALE_SENTINEL', 'read the current proposals with pullboard sentinels');
      const digest = values.digest ?? current.digest;
      if (digest !== current.digest) throw new Refused('STALE_SENTINEL', 'this proposal changed after it was shown; refresh the pending watch and decide its current command, directory and schedule');
      const confirmed = await requireSignedPerson(ctx, board, me, { verb: `sentinel-${verb}`, args: { name, digest, ...(verb === 'decline' ? { reason: String(values.reason ?? '') } : {}) } });
      if (confirmed !== null) return confirmed;
      requirePersonChannel(ctx.io.personChannel);
      row = await ordered(ctx, board, 'decideSentinel', [{ agentId: PERSON, channel: ctx.io.personChannel ?? 'terminal',
        name, digest, decision: verb, reason: (values.reason ?? '').trim() }]);
    }
    ctx.io.result?.({ sentinel: row });
    ctx.io.say(`${name}: ${row.status}; ${row.every}; owner ${row.owner}; directory ${row.directory}\n  ${row.check}`);
    if (row.status === 'pending') ctx.io.say(`next: the person approves this exact row with pullboard sentinel approve ${name}, or declines it with --reason "<why>"`);
    return 0;
  });
}

/** Reject an extra list argument before opening the board, as the CLI does. */
export function sentinelListCommand(first, getContext, withBoard) {
  if (first) throw new Refused('USAGE', 'pullboard sentinels lists the current board watches');
  return sentinelList(getContext(), withBoard);
}

/** Show the current approval, latest outcome and owner without running any command. */
export function sentinelList(ctx, withBoard) {
  return withBoard(ctx, board => {
    const rows = sentinels(board);
    ctx.io.result?.({ sentinels: rows });
    for (const row of rows) {
      ctx.io.say(`${row.name}: ${row.status}; ${row.every}; owner ${row.owner}; last ${row.lastRun?.at ?? 'never'}; ${row.lastRun ? row.lastRun.green ? 'green' : 'red' : 'unrun'}\n  directory ${row.directory}; ${row.check}`);
    }
    if (!rows.length) ctx.io.say('no board watches; propose one with pullboard sentinel propose <name> --check "<command>" --every 10m --owner coordinator');
    return 0;
  });
}
