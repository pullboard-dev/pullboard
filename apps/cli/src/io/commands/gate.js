import { blockingFailures } from '../../../../../packages/verify/index.js';
import { quarantineWaivers } from '../../../../../packages/flakes/index.js';
import { quarantineVerdictSnapshot } from '../../../../../packages/flakes/index.js';
import { sealQuarantineVerdict } from '../../../../../packages/flakes/index.js';
import { boardReceiptStore } from '../../../../../packages/gate/index.js';
import { readGateReceipt } from '../../../../../packages/gate/index.js';
import { checkAtCommit } from '../../../../runner/index.js';
/** The pullboard gate command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../../packages/landing/index.js';
import {
  CONFIG_FILE,
} from '../../../../../packages/config/index.js';
import { setHere } from '../../../../../packages/gate/index.js';
import {
} from '../../../../../packages/gate/index.js';
import {
  gateReport,
  runGate,
} from '../../../../../packages/gate/index.js';
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
import {
  existsSync,
} from 'node:fs';
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
import { submitHandoff } from '../../../../../packages/store/index.js';
import { queueFor } from '../../../../../packages/api/index.js';
import { withdrawCancelsJob } from '../../../../../packages/config/index.js';
import { runStaticStageAdmitted } from '../static/stage.js';

/** Run `pullboard gate` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (first === 'set') return setHere(io, second, rest, values);
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
      && existsSync(join(ctx.info.root, CONFIG_FILE))) {
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
    const result = await ordered(ctx, board, 'completeSubmitHandoff', [item, { agentId: me.id, job: handoff?.id, withdrawn: true }]);
    if (handoff && ['queued', 'running'].includes(handoff.state)) dropHandoffTicket(handoff.id);
    // With gate.withdrawCancelsJob on, the item's gate job row ends as cancelled too, so a runner holding it sees the withdrawal on its next poll [C7,#3860].
    const cancelled = withdrawCancelsJob() ? cancelGateJob(board, item, { runs: queueFor(board, me.id, { file: ctx.file })?.runs ?? null }).jobs : [];
    io.result?.({ item, withdrawn: true, job: result?.id ?? handoff?.id ?? null, ...(cancelled.length ? { cancelled } : {}) });
    io.say(`gate withdrawn for #${item}; pullboard submit ${item} starts a new one`);
    return 0;
  });
}
