import { quarantineWaivers } from '../quarantine.js';
import { checkAtCommit } from '../runner-private-check.js';
/** The pullboard gate command, in its own module so an item adding another command never edits these lines. */
import { runnerExecutionServices } from '../runners.js';
import { landingExecutionServices } from '../landing-shards.js';
import {
  CONFIG_FILE,
} from '../config.js';
import * as gateConfig from '../gate-config.js';
import {
  gateWaitReporter,
} from '../gate-wait.js';
import {
  gateReport,
  runGate,
} from '../gate.js';
import {
  accountedFailures,
  liveWaiverProjection,
  waivedFailures,
  waiverLine,
} from '../land.js';
import * as nativeFlakes from '../native-flake-cli.js';
import {
  Refused,
} from '../refused.js';
import {
  mainPolicy,
} from '../trusted-policy.js';
import {
  existsSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  context,
  ordered,
  resourceAgent,
  shellWord,
  uncommittedPolicySetup,
  withBoard,
} from '../cli.js';

/** Run `pullboard gate` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (first === 'set') return gateConfig.setHere(io, second, rest, values);
  if (values.receipt && !values.landing) throw new Refused('USAGE', 'use gate --landing --receipt to produce an exact native landing receipt');
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
  const gate = await runGate(ctx.info.root, config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: !needsReceipt, landing: values.landing, agent: resourceAgent(ctx), onWait: gateWaitReporter(io), stages: Boolean(values.landing), waivers,
    onFailure: nativeFlakes.observer(ctx, { kind: values.landing ? 'land' : 'gate', config }, { ordered, withBoard, resourceAgent, checkAtCommit }) });
  // A landing gate honours the person's live waivers exactly as land does; a red run never stamps, so it stays waived, not green [B3,R3].
  const waived = values.landing && !gate.isGreen ? withBoard(ctx, (board) => waivedFailures(board, accountedFailures(gate, ctx.info.root), { quarantineWaivers })) : null;
  if (waived) {
    const lines = waived.map(waiverLine);
    const report = `landing gate waived, not green: ${waived.length} failure(s), each covered by a live person waiver; the whole output is in ${gate.log}\n${lines.join('\n')}`;
    io.result?.({ green: false, waived: waived.map(({ file, name, waiver }) => ({ file, name, waiver: waiver.id, reason: waiver.reason, until: waiver.until })), report });
    io.say(report);
    return 0;
  }
  if (needsReceipt && gate.isGreen && !gate.receiptId) throw new Refused('LAND_RECEIPT_UNBOUND', 'the native gate could not bind its exact clean envelope; restore committed source and run gate --landing --receipt');
  io.result?.({ green: gate.isGreen, report: gateReport(gate), ...(values.landing ? { receiptId: gate.receiptId ?? null } : {}) });
  io.say(gateReport(gate));
  return gate.isGreen ? 0 : 1;
}
