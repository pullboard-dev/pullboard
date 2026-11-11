/**
 * The command line's entry: parse the arguments, bind the checkout, run the relay and baseline work around the
 * command when there is any, and dispatch through the lazy command table. It loads a module only when the command
 * in hand needs it, so --version and a read pay for nothing they do not run [C7].
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { commandOutput } from '../../../../../packages/config/browser.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { CHECKOUT_LEASES } from './session.js';
import { CHECKOUT_BOARD_ONLY } from './session.js';
import { traceServeStartup } from './session.js';
import { asksGitNothing } from './options.js';
import { parseCommandArgs } from './options.js';
import { appendTrace } from '../trace.js';
import { extractWhy } from '../../logic/why.js';

let startupMainTraced = false;

/** Commands that start no worktree-maintenance timer after they run; the timer's git reads cost every call about 190 ms [C7]. */
const QUIET_COMMANDS = new Set(['next', 'show', 'claim']);

/** Retain the primary branch on every command without creating a board for global help. */
async function rememberTrunk(io, { repoInfo, mainCheckout }) {
  let info;
  try { info = repoInfo(io.cwd); }
  catch (error) {
    if (error instanceof Refused && ['NOT_A_REPO', 'NO_REPO', 'CORE_BARE'].includes(error.code)) return;
    throw error;
  }
  if (!info.isMain) return;
  const primary = mainCheckout(info.root);
  if (primary?.branch) (await import('../../../../../packages/sandbox/light.js')).trunkRef(info.root, primary.branch);
}

/** Commands that write the board whatever their arguments. */
const WRITES = new Set(['handoff', 'bar', 'init', 'join', 'worktree', 'hooks', 'hook', 'skills', 'add', 'companion', 'edit', 'fact', 'escalate', 'run', 'sweep',
  'next', 'claim', 'hold', 'release', 'submit', 'ship', 'done', 'verify', 'check', 'merged', 'land', 'withdraw', 'refreeze', 'reopen', 'shout', 'answer', 'pass', 'import', 'milestone', 'takeover', 'forget']);

/**
 * Whether a command line writes the board. Reads bind no write session and wake no dispatcher recovery, so a read
 * such as whoami, show or status pays for neither [C7].
 *
 * @param {string[]} positionals - The command and its verb.
 * @returns {boolean}
 */
export function writesBoard([command, first]) {
  return WRITES.has(command) || (command === 'tool-build' && first === 'promote') || (command === 'patch' && ['attach', 'remove', 'object'].includes(first))
    || (command === 'request' && Boolean(first) && first !== 'list') || (command === 'lane' && first === 'add') || (command === 'settings' && Boolean(first))
    || (command === 'spec' && first === 'apply') || (command === 'relay' && ['on', 'off'].includes(first));
}

/**
 * Whether a command line wakes queued-handoff recovery: board writes do, reads and Git hooks never. Why: on 8 Nov a
 * commit-msg hook, heartbeats and inbox reads each ran recovery and waited minutes behind the dispatcher launch [C7].
 *
 * @param {string[]} positionals - The command and its verb.
 * @returns {boolean}
 */
export function wakesHandoffRecovery(positionals) {
  return writesBoard(positionals) && !['hook', 'hooks'].includes(positionals[0]);
}

/**
 * Bind this checkout to the session behind a write before any sync or side effect. Reads, help and authenticated
 * person channels keep their identity and load nothing for it.
 */
async function bindCheckoutSession(io, positionals, values) {
  if (values.help || values.version || io.personChannel === 'view' || io.personRequest) return;
  const [command] = positionals;
  if (command === 'takeover' && (positionals.length !== 1 || Object.keys(values).some((key) => key !== 'json'))) {
    throw new Refused('USAGE', 'pullboard takeover takes no arguments; run pullboard takeover [--json]');
  }
  if (!writesBoard(positionals)) return;
  if (command === 'answer' && values.as === 'person') return;
  await io.prepareProcessPorts();
  io.nativeBoard ??= await io.loadNativeBoard();
  return (await import('../entry.js')).bindWriteSession(io, positionals, values);
}

/** Run one command and emit its single versioned JSON result when requested (A1). */
async function timedMain(argv, streams) {
  if (argv[0] === 'serve' && !startupMainTraced) {
    startupMainTraced = true;
    traceServeStartup('cli-main-enter');
  }
  // Version and help ask Git nothing, so they never load it.
  if (asksGitNothing(argv)) return runMain(argv, streams);
  const { withGitFacts } = await import('../../../../../packages/git/index.js');
  let command;
  try { command = parseCommandArgs(argv).positionals[0]; } catch { /* Normal parsing renders usage. */ }
  if (!['submit', 'done'].includes(command)) return withGitFacts(() => runMain(argv, streams));
  const { captureSubmitTooling, retrySubmitTooling } = await import('../../../../../packages/runners/index.js');
  const attempt = { snapshot: captureSubmitTooling(), argv, cwd: streams.cwd ?? process.cwd() };
  const status = await withGitFacts(() => runMain(argv, { ...streams, submitToolingAttempt: attempt }));
  if (!attempt.retry) return status;
  // runMain's finally has released the original checkout lease before a fresh process can bind it.
  try { return await retrySubmitTooling(attempt.retry, argv, streams); }
  catch (error) {
    const output = commandOutput(argv, streams, { loadRefusal: async () => (await import('../../logic/step/words.js')).refusalDocument });
    await output.prepareRefusal();
    output.refusal(attempt.error);
    output.err(`automatic submit retry could not start (${error.code ?? error.message}); rerun pullboard submit`);
    output.flush(1);
    return 1;
  }
}

/** Record local command wall time without sending timing data to the board. */
export async function main(rawArgv, streams) {
  const { argv, why } = extractWhy(rawArgv);
  const { beginSeatTiming, timingSeat } = await import('../../../../../packages/seats/light.js');
  const cwd = streams.cwd ?? process.cwd();
  const item = /^[1-9][0-9]*$/u.test(argv[1] ?? '') ? Number(argv[1]) : null;
  const binding = timingSeat(cwd);
  const finish = beginSeatTiming(cwd, 'command', argv[0] ?? 'help', item, binding);
  const lockPort = Symbol.for('pullboard.seat-timing.lock');
  const previous = globalThis[lockPort];
  globalThis[lockPort] = () => beginSeatTiming(cwd, 'lock-wait', 'board write lock', item, binding);
  const startedAt = Date.now();
  const traced = { refusal: null };
  let status; let thrown;
  try { status = await timedMain(argv, { ...streams, traceRecord: traced }); return status; }
  catch (error) { thrown = error; status = 1; throw error; }
  finally {
    finish(); if (previous) globalThis[lockPort] = previous; else delete globalThis[lockPort];
    // One line per run on every exit path, a thrown Refused or an uncaught error included [C7].
    appendTrace({ argv, cwd, startedAt, status, error: thrown, refusal: traced.refusal, seat: binding?.seat ?? null, why });
  }
}

/** Parse and execute one CLI command, binding its checkout session and Git-fact scope. */
async function runMain(argv, streams) {
  const io = commandOutput(argv, streams, {
    nextActions: streams.nextActions ?? (process.env.PULLBOARD_TEXT_NEXT !== '0'),
    loadRefusal: async () => (await import('../../logic/step/words.js')).refusalDocument,
  });
  if (streams.traceRecord) {
    // Remember the refusal the command reports so its trace line carries the code and message.
    const report = io.refusal;
    io.refusal = (error, ...rest) => { streams.traceRecord.refusal = error; return report.call(io, error, ...rest); };
  }
  io.loadNativeBoard = streams.loadNativeBoard;
  io.withOutboxGuard = streams.withOutboxGuard;
  io.replayConflictRecord = streams.replayConflictRecord;
  io.remoteBoardMissing = streams.remoteBoardMissing;
  io.uncertainUploadFailure = streams.uncertainUploadFailure;
  io.decideUncertainBaseline = streams.decideUncertainBaseline;
  io.checkpointPublisher = streams.checkpointPublisher;
  io.relayOrdering = streams.relayOrdering;
  io.checkpointInBackground = streams.checkpointInBackground;
  io.scheduleCheckpoint = streams.scheduleCheckpoint;
  io.requestCheckpointCheck = streams.requestCheckpointCheck;
  io.checkpointWorker = streams.checkpointWorker;
  io.openBoard = streams.openBoard ?? ((...args) => io.nativeBoard.openBoard(...args));
  io.nativeBoardPorts = streams.nativeBoardPorts ?? ((...args) => io.nativeBoard.nativeBoardPorts(...args));
  io.outboxFields = streams.outboxFields; io.outboxPolicy = streams.outboxPolicy; io.flushOutbox = streams.flushOutbox; io.queueMove = streams.queueMove; io.outboxHasPendingCreatedItem = streams.outboxHasPendingCreatedItem;
  io.loadProcessPorts = streams.loadProcessPorts;
  /** A queue-wait reporter supplied by the composition root; a caller that supplies none gets a silent one. */
  io.gateWaitReporter = streams.gateWaitReporter ?? (() => () => {});
  /** Materialize only this invocation's explicit process capabilities, at most once. */
  io.prepareProcessPorts = async () => {
    if (!io.loadProcessPorts) return;
    Object.assign(io, await io.loadProcessPorts());
    io.loadProcessPorts = undefined;
  };
  io.hookWorker = streams.hookWorker;
  io.submitHandoffWorker = streams.submitHandoffWorker;
  // In-process tests replace the detached audit launch; production always starts apps/cli/src/io/landing/audit.js.
  io.nudgeMainAudit = streams.nudgeMainAudit;
  /** Bind recursive CLI operations to this process root's native provider. */
  io.runCommand = (args, nextStreams) => main(args, { ...nextStreams, gateWaitReporter: io.gateWaitReporter, loadProcessPorts: io.loadProcessPorts, loadNativeBoard: io.loadNativeBoard, hookWorker: io.hookWorker, submitHandoffWorker: io.submitHandoffWorker, launchRelaySender: io.launchRelaySender, withOutboxGuard: io.withOutboxGuard, replayConflictRecord: io.replayConflictRecord, remoteBoardMissing: io.remoteBoardMissing, uncertainUploadFailure: io.uncertainUploadFailure, decideUncertainBaseline: io.decideUncertainBaseline, checkpointPublisher: io.checkpointPublisher, relayOrdering: io.relayOrdering, checkpointInBackground: io.checkpointInBackground, scheduleCheckpoint: io.scheduleCheckpoint, requestCheckpointCheck: io.requestCheckpointCheck, checkpointWorker: io.checkpointWorker, openBoard: io.openBoard, nativeBoardPorts: io.nativeBoardPorts, outboxFields: io.outboxFields, outboxPolicy: io.outboxPolicy, flushOutbox: io.flushOutbox, queueMove: io.queueMove, outboxHasPendingCreatedItem: io.outboxHasPendingCreatedItem });
  // Background launch is a CLI operation; lower relay code receives it explicitly.
  io.launchRelaySender = streams.launchRelaySender;
  let sync = true;
  let needsRepo = true;
  let parsed;
  let checkoutSession;
  let auditAfterCommand = false;
  let advanceAfterCommand = false;
  let maintenanceAfterCommand;
  let automaticLandingAfterCommand;
  let toolBuildGateAfterCommand;
  try {
    parsed = parseCommandArgs(argv);
    const command = parsed.positionals[0];
    io.relayJson = Boolean(parsed.values.json);
    io.relayCommand = { cliOperation: command === 'done' ? 'submit' : command, cwd: resolve(io.cwd),
      positionals: parsed.positionals.slice(1),
      values: Object.fromEntries(Object.keys(parsed.values).filter(key => key !== 'json').sort().map(key => [key, parsed.values[key]])) };
    sync = Boolean(command) && !parsed.values.help && !parsed.values.version
      && !['help', 'version', 'hook', 'init', 'relay', 'tour', 'mcp', 'health', 'watch', 'digest'].includes(command)
      // A private item never makes an otherwise unrelated repo transport on the way in or out.
      && !(command === 'add' && parsed.values.private === true)
      && !(command === 'verify' && parsed.values.compare)
      // A coordinator declaration on a linked clone must refuse before auto-link or relay sync.
      && !(command === 'join' && parsed.positionals[1] === (await import('../../../../../packages/config/index.js')).COORDINATOR);
    needsRepo = !(parsed.values.help || parsed.values.version || command === 'help' || command === 'version');
  } catch { sync = false; needsRepo = false; }
  // Agent nudges never enter Git-hook identity, synchronization or refusal machinery.
  if (parsed?.positionals[0] === 'hook' && !parsed.values.help && !parsed.values.version
      && !['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push'].includes(parsed.positionals[1])) {
    await io.prepareProcessPorts();
    return (await import('../../../../../packages/seats/index.js')).runAgentHook(io, parsed.positionals[1], io.hookWorker);
  }
  const git = needsRepo ? await import('../../../../../packages/git/index.js') : null;
  git?.setResumeSourceFacts(parsed?.positionals[0] === 'resume');
  if (parsed) {
    try {
      // Checkout identity supplies the display role even if a person-channel check refuses first.
      try { const info = needsRepo ? git.repoInfo(io.cwd) : null; if (info?.isMain) io.caller('coordinator', info.root); } catch { /* Unknown checkouts retain existing guidance. */ }
      let preflightRelay;
      if (parsed.values.as === 'person' && !parsed.values.help && !parsed.values.version) {
        await io.prepareProcessPorts();
        io.nativeBoard ??= await io.loadNativeBoard();
        preflightRelay = (({ DEFAULT_RELAY, relayStatus }) => ({ DEFAULT_RELAY, relayStatus }))(await import('../../../../../packages/link/index.js'));
      }
      const [command, verb] = parsed.positionals;
      const remoteRelayOn = command === 'relay' && verb === 'on' && !parsed.values.all;
      if (!parsed.values.help && !parsed.values.version &&
          (parsed.values.as === 'person' && command !== 'decisions' && !await (await import('../../../../../packages/person/index.js')).personMovesSigned(io.cwd, io, { ...preflightRelay, relayStatus: root => preflightRelay.relayStatus(root, io),
            openBoard: (await import('../context.js')).nativeBoardOpeners(io).openBoard }) || command === 'relay' && ['on', 'join', 'revoke', 'members'].includes(verb) && !remoteRelayOn)) {
        (await import('../../../../../packages/person/index.js')).requirePersonChannel(io.personChannel);
        io.caller('person');
      }
      checkoutSession = await bindCheckoutSession(io, parsed.positionals, parsed.values);
      if (checkoutSession?.lease) CHECKOUT_LEASES.set(io, checkoutSession.lease);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      io.refusal(error);
      io.err(`pullboard: ${await (await import('./run/command.js')).displayedRefusal(io, error)}\nnext: ${io.refusalDocument(error).error.next}`);
      (await import('../next/steps.js')).reportBlock(io, error, { command: parsed.positionals[0] });
      io.flush(1);
      return 1;
    }
  }
  try {
    if (needsRepo) {
      await rememberTrunk(io, git);
      if (!parsed?.values['dry-run'] && wakesHandoffRecovery(parsed?.positionals ?? [])) {
        await (await import('./recovery.js')).recoverQueuedHandoffs(io, git);
      }
    }
    traceServeStartup('cli-command-preamble-start');
    // The relay and baseline work loads only where a relay token, relay state, a link or a pending result exists.
    /** Load the work around the command when any of it could act here, or null. */
    const syncWork = async () => {
      if (!sync || !(await import('../../../../../packages/store/index.js')).syncMayAct(io.cwd)) return null;
      await io.prepareProcessPorts();
      io.nativeBoard ??= await io.loadNativeBoard();
      return import('../sync.js');
    };
    await (await syncWork())?.syncBefore(io, io.runCommand);
    traceServeStartup('cli-command-preamble-ready');
    const code = await (await import('./run/command.js')).runCommand(argv, io);
    if (io.submitToolingAttempt?.retry) return code;
    // A sweep nudges whenever main left its last audited tip, so a hotfix or plain merged is audited too.
    const sweep = parsed?.positionals[0] === 'sentinel' && parsed.positionals[1] === 'run' && parsed.positionals.length === 2;
    auditAfterCommand = code === 0 && ((parsed?.positionals[0] === 'land'
      && !parsed.values['dry-run'] && parsed.values.waive === undefined)
      || (parsed?.positionals[0] === 'merged' && parsed.values['gate-receipt'] !== undefined)
      || (sweep && (await import('../../../../../packages/gate/index.js')).mainMovedSinceAudit(io.cwd)));
    advanceAfterCommand = code === 0 && !parsed.values['dry-run'] && (auditAfterCommand
      || parsed.positionals[0] === 'merged' || parsed.positionals[0] === 'sentinel' && parsed.positionals[1] === 'run');
    if (code === 0) {
      await checkoutSession?.finish?.();
    }
    if (code === 0) await (await syncWork())?.retrySync(io);
    const status = io.exitCode(code);
    if (status === 0 && needsRepo && !parsed?.values['dry-run'] && parsed?.positionals[0] !== 'maintenance'
      && !QUIET_COMMANDS.has(parsed?.positionals[0])) {
      // The foreground command already read this configuration; disabled maintenance adds no second context read.
      maintenanceAfterCommand = io.worktreeMaintenanceContext;
      automaticLandingAfterCommand = io.automaticLandingContext;
    }
    if (status === 0 && needsRepo && !parsed?.values['dry-run'] && parsed?.positionals[0] !== 'tool-build') toolBuildGateAfterCommand = io.toolBuildGateContext;
    if (status === 0 && needsRepo && !parsed?.values['dry-run']) (await import('../../../../../packages/items/index.js')).clearCompletedBlocks(io, { requirePersonChannel: (await import('../../../../../packages/person/index.js')).requirePersonChannel });
    if (status !== 0) await io.prepareRefusal();
    io.flush(status);
    return status;
  } finally {
    CHECKOUT_LEASES.delete(io);
    CHECKOUT_BOARD_ONLY.delete(io);
    checkoutSession?.lease?.release();
    if (automaticLandingAfterCommand) {
      // A release run from an item folder removes that folder before this wake; the pending record names the
      // trunk checkout, so the wake uses it. Why: on 6 Nov every such release printed NOT_A_REPO and woke nothing [C7].
      const { info } = automaticLandingAfterCommand;
      const wakeRoot = existsSync(info.root) ? info.root : landingJobRoot(info.commonDir) ?? info.root;
      try {
        const worker = await import('../../../../../packages/landing/index.js');
        // The wake reopens the board in this process; sharing the command's set keeps a schema notice to one line [A5,C7].
        const schemaDiagnostics = automaticLandingAfterCommand.io.schemaDiagnostics ??= new Set();
        // A backed-off lander waits out its back-off unless an accept, a green gate or a held-test correction came since [C7].
        // One board read answers both: recovery and the bootstrap share the answer for the same record.
        const answers = new Map();
        const woken = async job => {
          if (!answers.has(job.id)) answers.set(job.id, (await import('../landing/automatic.js')).landingBackoffWoken(job.root, job, { schemaDiagnostics }));
          return answers.get(job.id);
        };
        const recovered = await worker.recoverAutomaticLanding(wakeRoot, new URL('../landing/automatic.js', import.meta.url), { woken });
        if (!recovered) await (await import('../landing/automatic.js')).bootstrapLandingWake(wakeRoot, { schemaDiagnostics, woken });
      }
      catch (error) { io.err(`automatic landing wake unavailable: ${error.code ?? error.name}: ${error.message}`); }
    }
    if (maintenanceAfterCommand) {
      try { await (await import('../worktree/maintenance/scheduler.js')).scheduleWorktreeMaintenance(maintenanceAfterCommand); }
      catch (error) { io.err((await import('../worktree/maintenance/diagnostics.js')).maintenanceTimerWarning(error)); }
    }
    if (toolBuildGateAfterCommand) {
      try { await (await import('../tool/build.js')).scheduleToolBuildGate(toolBuildGateAfterCommand); }
      catch (error) { io.err(`tool build gate timer unavailable: ${error.code ?? error.name}`); }
    }
    if (advanceAfterCommand) {
      try {
        let eligible = true;
        try {
          const { landingLeaseState } = await import('../../../../../packages/store/index.js');
          eligible = (await import('../../../../../packages/sandbox/index.js')).hasSourceAdvanceJobs(io.cwd, { landingLeaseState,
            openBoardForRead: (await import('../context.js')).nativeBoardOpeners(io).openBoardForRead });
        }
        catch { /* Unknown state keeps the normal worker path, which records incomplete work. */ }
        await (await import('../../../../../packages/git/index.js')).nudgeSourceAdvances(io.cwd, {
          workerUrl: new URL('../landing/advance.js', import.meta.url), eligible,
        });
      }
      catch { io.err('pullboard: the automatic main-merge worker could not start; run pullboard sentinel run --health-only to retry'); }
    }
    if (auditAfterCommand) {
      try { await (io.nudgeMainAudit ?? (await import('../../../../../packages/gate/index.js')).nudgeMainAudit)(io.cwd, new URL('../landing/audit.js', import.meta.url)); }
      catch { io.err('pullboard: the full-suite audit could not start; run pullboard sentinel run to retry'); }
    }
  }
}

// This marker is emitted once when the actual CLI entrypoint finishes evaluating.
if (process.env.PULLBOARD_STARTUP_TRACE_ENTRY
  && resolve(process.argv[1] ?? '') === resolve(process.env.PULLBOARD_STARTUP_TRACE_ENTRY)) {
  traceServeStartup('cli-module-load-complete');
}

/** The trunk checkout the pending landing record names, or null when there is no readable record. */
function landingJobRoot(commonDir) {
  try { return JSON.parse(readFileSync(join(commonDir, 'pullboard', 'automatic-landing', 'pending.json'), 'utf8')).root ?? null; }
  catch { return null; }
}
