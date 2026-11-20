import { blockingFailures } from '../../../../../packages/verify/index.js';
import { quarantineWaivers } from '../../../../../packages/flakes/index.js';
import { quarantineVerdictSnapshot } from '../../../../../packages/flakes/index.js';
import { sealQuarantineVerdict } from '../../../../../packages/flakes/index.js';
import { boardReceiptStore } from '../../../../../packages/gate/heavy.js';
import { readGateReceipt } from '../../../../../packages/gate/heavy.js';
import { checkAtCommit } from '../../../../runner/index.js';
/** The pullboard gate command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import {
  CONFIG_FILE,
} from '../../../../../packages/config/index.js';
import { setHere } from '../../../../../packages/gate/heavy.js';
import {
  gateReport,
  runGate,
} from '../../../../../packages/gate/heavy.js';
import {
  accountedFailures,
  liveWaiverProjection,
  waivedFailures,
  waiverLine,
} from '../../../../../packages/landing/index.js';
import {
  observer as flakeObserver,
} from '../../../../../packages/flakes/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  mainPolicy,
} from '../../../../../packages/sandbox/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import {
  join,
} from 'node:path';
import {
  context,
  idArg,
  ordered,
  resourceAgent,
  shellWord,
  uncommittedPolicySetup,
  withBoard,
} from '../entry.js';
import { actOn } from '../board/access.js';
import { dropHandoffTicket } from '../../../../../packages/resources/index.js';
import { cancelGateJob } from '../../../../../packages/store/index.js';
import { coordinatorOnly } from '../../../../../packages/store/index.js';
import { submitHandoff } from '../../../../../packages/store/index.js';
import { offeredRequest } from '../../../../../packages/api/index.js';
import { queueFor } from '../../../../../packages/api/index.js';
import { endStaleShardOffers } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { withdrawCancelsJob } from '../../../../../packages/config/index.js';
import { runStaticStageAdmitted } from '../static/stage.js';

const fs = fileSystemAdapter();

/** Run `pullboard gate` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (first === 'set') return setHere(io, second, rest, values);
  if (values.withdraw === 'shards' || values['stale-before'] !== undefined) return withdrawStaleShards(io, values);
  if (values.withdraw !== undefined) return withdrawGate(io, values.withdraw);
  if (values.static) return runStaticStageAdmitted(io, context(io).info.root);
  if (values.receipt && !values.landing) throw new Refused('USAGE', 'use gate --landing --receipt to produce an exact native landing receipt');
  if (values['runner-only'] && !(values.landing && values.receipt)) throw new Refused('USAGE', 'use gate --landing --receipt --runner-only for a full runner gate');
  if (first !== undefined || second !== undefined || rest.length > 0) {
    const words = [first, second, ...rest].filter((word) => word !== undefined);
    const next = 'use pullboard resources for status, or pullboard gate with no extra words to run the gate';
    throw new Refused('GATE_ARGUMENT', `pullboard gate does not accept extra words: ${words.join(' ')}. Use pullboard resources for status, or pullboard gate with no extra words to run the gate.`, next);
  }
  const ctx = context(io);
  let config;
  try { config = mainPolicy(ctx.info.root).config; }
  catch (error) {
    if (error instanceof Refused && error.code === 'NO_POLICY'
      && error.message.includes('the coordinator checkout has no commit on ')
      && fs.exists(join(ctx.info.root, CONFIG_FILE))) {
      throw new Refused('NO_POLICY', `${CONFIG_FILE} is not committed; add and commit the initialized project before running the gate: git add ${CONFIG_FILE}`);
    }
    // Refused prefixes its message with the code, so match the condition itself, not the text:
    // pullboard.json on disk but absent from the primary checkout's commit. Any other
    // missing policy or claim base keeps its own refusal.
    if (error instanceof Refused && error.code === 'NO_POLICY') {
      let setup = null;
      try { setup = uncommittedPolicySetup(ctx.info); } catch { /* Report the original refusal below. */ }
      if (setup) {
        const files = setup.files.map(shellWord).join(' ');
        throw new Refused('NO_POLICY', `${CONFIG_FILE} and Pullboard's initialized setup files are uncommitted; commit them before running the gate: ${setup.stage} && git commit -q -m "chore: set up pullboard" -- ${files}`);
      }
    }
    throw error;
  }
  const waivers = values.landing ? withBoard(ctx, (board) => liveWaiverProjection(board, { quarantineWaivers })) : [];
  const needsReceipt = values.landing && (values.receipt || config.landing?.requireReceipts === true);
  const quarantines = withBoard(ctx, quarantineVerdictSnapshot);
  const gate = await runGate(ctx.info.root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: !needsReceipt, landing: values.landing, runnerOnly: values['runner-only'] === true, agent: resourceAgent(ctx), onWait: io.gateWaitReporter(io), stages: Boolean(values.landing), waivers, quarantines,
    onFailure: flakeObserver(ctx, { kind: values.landing ? 'land' : 'gate', config }, { ordered, withBoard, resourceAgent, checkAtCommit }) });
  // Recording diagnostics is best effort; granting an exception always rechecks current authority.
  if (gate.blockingVerdict) withBoard(ctx, board => {
    const receipt = readGateReceipt(boardReceiptStore(board), gate.receiptId);
    if (!receipt) throw new Refused('PROOF_RUN_UNBOUND', 'the computed gate verdict needs its stored native receipt');
    sealQuarantineVerdict(board, receipt);
  });
  // A landing gate honours the person's live waivers exactly as land does; a red run never stamps, so it stays waived, not green [B3,R3].
  const waived = values.landing && !gate.isGreen ? withBoard(ctx, (board) => waivedFailures(board, blockingFailures(gate, accountedFailures(gate, ctx.info.root)), { quarantineWaivers })) : null;
  if (waived) {
    const lines = waived.map(waiverLine);
    const report = `landing gate waived, not green: ${waived.length} failure(s), each covered by a live person waiver; the whole output is in ${gate.log}\n${lines.join('\n')}`;
    io.result?.({ green: false, waived: waived.map(({ file, name, waiver }) => ({ file, name, waiver: waiver.id, reason: waiver.reason, until: waiver.until })), report });
    io.say(report);
    return 0;
  }
  if (needsReceipt && gate.isGreen && !gate.receiptId) throw new Refused('LAND_RECEIPT_UNBOUND', 'the native gate could not bind its exact clean envelope; restore committed source and run gate --landing --receipt');
  io.result?.({ green: gate.isGreen, report: gateReport(gate), ...(gate.blockingVerdict ? { rawExitCode: gate.exitCode, quarantine: { proofReceiptId: gate.proofReceiptId ?? gate.receiptId,
    coveredCases: gate.blockingVerdict.quarantines.length, eventIds: gate.blockingVerdict.quarantines.slice(0, 8).map(row => row.eventId),
    omittedEvents: Math.max(0, gate.blockingVerdict.quarantines.length - 8) } } : {}), ...(values.landing ? { receiptId: gate.receiptId ?? null } : {}) });
  io.say(gateReport(gate));
  return gate.isGreen ? 0 : 1;
}

/**
 * Run `pullboard gate --withdraw <id>`: record the item's queued or running gate as withdrawn and drop its place in line.
 * Why: a gate stuck in the line had no command to stop it; the holder or the coordinator ends it, and submitting again starts a new one.
 */
async function withdrawGate(io, value) {
  return actOn(io, async (ctx, board, me) => {
    const item = idArg(value);
    const handoff = submitHandoff(board, item);
    const runs = queueFor(board, me.id, { file: ctx.file })?.runs ?? null;
    const waiting = handoff && ['queued', 'running'].includes(handoff.state);
    // A pulled gate has no hand-off record, only its job row: with gate.withdrawCancelsJob on, the row is the gate to withdraw [C7,#3860].
    const cancelOn = withdrawCancelsJob();
    const live = cancelOn && !waiting ? jobsOf(runs?.db ?? board.db, { kind: 'gate', item }).filter(job => !['done', 'cancelled'].includes(job.step)) : [];
    if (live.length) {
      const holder = offeredRequest(board.db, live[0].id, { runs })?.submit?.agentId;
      if (holder && holder !== me.id && me.id !== 'coordinator') throw new Refused('NOT_YOURS', `only the seat that submitted #${item} or the coordinator can withdraw its gate; ask ${holder} or the coordinator`);
    }
    const result = live.length ? null : await ordered(ctx, board, 'completeSubmitHandoff', [item, { agentId: me.id, job: handoff?.id, withdrawn: true }]);
    if (waiting) dropHandoffTicket(handoff.id);
    // With the setting on, the item's gate job row ends as cancelled too, so a runner holding it sees the withdrawal on its next poll [C7,#3860].
    const cancelled = cancelOn ? cancelGateJob(board, item, { runs }).jobs : [];
    io.result?.({ item, withdrawn: true, job: result?.id ?? handoff?.id ?? cancelled[0] ?? null, ...(cancelled.length ? { cancelled } : {}) });
    io.say(`gate withdrawn for #${item}; pullboard submit ${item} starts a new one`);
    return 0;
  });
}

/**
 * Run `pullboard gate --withdraw shards --stale-before <sha> [--dry-run]`: end, or with --dry-run only list, the offered
 * shards of every gate whose candidate does not contain the commit, and note on each item why and what to do next. Coordinator only.
 * Why: gates built before a main fix held shards certain to go red, and gate --withdraw <id> skips a gate whose gate job is done (#12167).
 */
async function withdrawStaleShards(io, values) {
  const before = typeof values['stale-before'] === 'string' ? values['stale-before'].trim() : '';
  if (values.withdraw !== 'shards' || !before) throw new Refused('USAGE', 'use pullboard gate --withdraw shards --stale-before <sha> [--dry-run]');
  return actOn(io, async (ctx, board, me) => {
    coordinatorOnly(me.id, 'ends the offered shards of stale gates');
    const dryRun = values['dry-run'] === true;
    // While runs_store is on the jobs live in the runs file, as withdrawGate reads them [B2,P7].
    const db = queueFor(board, me.id, { file: ctx.file })?.runs?.db ?? board.db;
    const result = endStaleShardOffers(db, { root: ctx.info.root, before, dryRun });
    const short = result.before.slice(0, 12);
    if (!dryRun) for (const one of result.gates) {
      if (!Number.isSafeInteger(one.item)) continue;
      await ordered(ctx, board, 'appendFact', [one.item, { agentId: me.id, kind: 'note',
        text: `Gate job ${one.gate}: the coordinator ended ${one.shards.length} offered shard(s); its candidate ${String(one.candidate).slice(0, 12)} does not contain main commit ${short}. Next: merge main and submit again.` }]);
    }
    const word = dryRun ? 'would end' : 'ended';
    const total = result.gates.reduce((sum, one) => sum + one.shards.length, 0);
    const lines = result.gates.map(one => `#${one.item ?? '?'} ${one.gate} at ${String(one.candidate).slice(0, 12)}: ${word} ${one.shards.length} offered shard(s)`);
    const unknown = result.unknown.length ? `; left ${result.unknown.length} candidate(s) git cannot read` : '';
    io.result?.({ before: result.before, dryRun, gates: result.gates, unknown: result.unknown, ended: result.ended, total });
    io.say([...lines, `${dryRun ? 'dry run: ' : ''}${word} ${total} offered shard(s) of ${result.gates.length} gate(s) whose candidate lacks ${short}${unknown}`].join('\n'));
    return 0;
  });
}
