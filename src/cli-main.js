export { selectedToolEntry } from './pinned-tool-build.js';
import { maintenanceTimerWarning } from './worktree-maintenance-diagnostics.js';
import { recordedMoveRefusal } from '../packages/state/index.js';
/**
 * The command line's entry: parse the arguments, bind the checkout, run the relay and baseline work around the
 * command when there is any, and dispatch through the lazy command table. It loads a module only when the command
 * in hand needs it, so --version and a read pay for nothing they do not run [C7].
 */
import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { COMMANDS } from './commands/index.js';
import { commandOutput } from '../packages/config/index.js';
import { Refused } from '../packages/kernel/index.js';

export const CHECKOUT_LEASES = new WeakMap();
export const CHECKOUT_BOARD_ONLY = new WeakMap();
let startupMainTraced = false;

/** Append an opt-in startup phase marker for the real CLI fixture measurement [A2,C7]. */
export function traceServeStartup(phase) {
  const path = process.env.PULLBOARD_STARTUP_TRACE_FILE;
  const entry = process.env.PULLBOARD_STARTUP_TRACE_ENTRY;
  if (!path || !entry || resolve(process.argv[1] ?? '') !== resolve(entry)) return;
  try {
    appendFileSync(path, `${JSON.stringify({ phase, at: Date.now(), elapsedMs: performance.now(),
      processId: process.pid, cpuUsage: process.cpuUsage(), loadAverage: loadavg(),
      eventLoopUtilization: performance.eventLoopUtilization() })}\n`);
  } catch {
    // Diagnostic tracing must not change normal CLI behavior.
  }
}

const OPTIONS = {
  criterion: { type: 'string' },
  files: { type: 'string' },
  'force-size': { type: 'string' },
  sensitive: { type: 'boolean' },
  'review-tier': { type: 'string' },
  'review-family': { type: 'string' },
  sandbox: { type: 'boolean' },
  lane: { type: 'string' },
  specs: { type: 'string' },
  parent: { type: 'string' },
  reason: { type: 'string' },
  revises: { type: 'string' },
  status: { type: 'string' },
  off: { type: 'boolean' },
  stale: { type: 'boolean' },
  port: { type: 'string' },
  slots: { type: 'string' },
  browser: { type: 'string' },
  'new-browser': { type: 'boolean' },
  node: { type: 'string' },
  root: { type: 'string' },
  project: { type: 'boolean' },
  export: { type: 'string' },
  public: { type: 'boolean' },
  'no-open': { type: 'boolean' },
  'no-next': { type: 'boolean' },
  lan: { type: 'boolean' },
  'no-permissions': { type: 'boolean' },
  'no-hooks': { type: 'boolean' },
  note: { type: 'string' },
  infra: { type: 'string' },
  'note-file': { type: 'string' },
  by: { type: 'string' },
  author: { type: 'string' },
  key: { type: 'string' },
  out: { type: 'string' },
  watch: { type: 'boolean' },
  'runner-only': { type: 'boolean' },
  after: { type: 'string' },
  on: { type: 'string' },
  brief: { type: 'string' },
  'brief-file': { type: 'string' },
  private: { type: 'boolean' },
  'coverage-file': { type: 'string' },
  text: { type: 'string' },
  gate: { type: 'string' },
  'gate-receipt': { type: 'string' },
  receipt: { type: 'boolean' },
  aim: { type: 'boolean' },
  doctrine: { type: 'boolean' },
  source: { type: 'string' },
  section: { type: 'string' },
  blueprint: { type: 'string', multiple: true },
  route: { type: 'string' },
  family: { type: 'string' }, 'review-family': { type: 'string' },
  model: { type: 'string' },
  as: { type: 'string' },
  check: { type: 'string' },
  // The watch command's options.
  every: { type: 'string' },
  scale: { type: 'boolean' },
  cycles: { type: 'string' },
  owner: { type: 'string' },
  directory: { type: 'string' },
  timeout: { type: 'string' },
  sentinel: { type: 'boolean' },
  'health-only': { type: 'boolean' },
  digest: { type: 'string' },
  // The rigor quality draft's options.
  base: { type: 'string' },
  head: { type: 'string' },
  rule: { type: 'string' },
  budget: { type: 'string' },
  'draft-quality': { type: 'boolean' },
  yes: { type: 'boolean' },
  diagnostics: { type: 'boolean' },
  landing: { type: 'boolean' },
  adopt: { type: 'boolean' },
  due: { type: 'boolean' },
  affected: { type: 'boolean' },
  waive: { type: 'string' },
  until: { type: 'string' },
  take: { type: 'string' },
  agent: { type: 'string' },
  'agent-light': { type: 'string' },
  'agent-mid': { type: 'string' },
  'agent-strong': { type: 'string' },
  attempts: { type: 'string' },
  'acted-on': { type: 'string' },
  minutes: { type: 'string' },
  items: { type: 'string' },
  run: { type: 'string' },
  max: { type: 'string' },
  'dry-run': { type: 'boolean' },
  update: { type: 'boolean' },
  before: { type: 'string' },
  overflow: { type: 'string' },
  target: { type: 'string' },
  next: { type: 'string' },
  add: { type: 'string' },
  remove: { type: 'string' },
  swap: { type: 'string' },
  limit: { type: 'string' },
  transcripts: { type: 'string' },
  checkpoint: { type: 'string' },
  name: { type: 'string' },
  title: { type: 'string' },
  url: { type: 'string' },
  skip: { type: 'string' },
  wait: { type: 'string' },
  verify: { type: 'boolean' },
  build: { type: 'boolean' },
  all: { type: 'boolean' },
  must: { type: 'boolean' },
  json: { type: 'boolean' },
  detail: { type: 'boolean' },
  fields: { type: 'string' },
  history: { type: 'boolean' },
  verbose: { type: 'boolean' },
  since: { type: 'string' },
  window: { type: 'string' },
  compare: { type: 'boolean' },
  policy: { type: 'string' },
  decision: { type: 'boolean' },
  kind: { type: 'string' },
  options: { type: 'string' },
  effects: { type: 'string' },
  news: { type: 'boolean' },
  evidence: { type: 'string' },
  outcome: { type: 'string' },
  item: { type: 'string' },
  for: { type: 'string' },
  kinds: { type: 'string' }, to: { type: 'string' }, work: { type: 'string' }, 'review-wait': { type: 'string' },
  commit: { type: 'string' },
  ref: { type: 'string' },
  supersedes: { type: 'string' },
  answers: { type: 'string' },
  origin: { type: 'string' },
  rationale: { type: 'string' },
  conflict: { type: 'string', multiple: true },
  'withdraw-verdict': { type: 'boolean' },
  cause: { type: 'string' },
  tier: { type: 'string' },
  clause: { type: 'string' },
  'check-timing': { type: 'string' },
  'never-again': { type: 'boolean' },
  'session-end': { type: 'boolean' },
  'draft-splits': { type: 'boolean' },
  implies: { type: 'string' },
  owns: { type: 'string' },
  red: { type: 'string' },
  green: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/** Resolve command-specific switches before parsing their ambiguous global string forms. */
function parseCommandArgs(argv) {
  let command;
  choose: for (const wait of [{ type: 'boolean' }, OPTIONS.wait]) {
    for (const take of [{ type: 'boolean' }, OPTIONS.take]) {
      try {
        const candidate = parseArgs({ args: argv, options: { ...OPTIONS, wait, take }, allowPositionals: true }).positionals[0];
        if (command === undefined) command = candidate;
        if (['add', 'edit', 'submit', 'done'].includes(candidate) !== (wait.type === 'boolean')) continue;
        if ((candidate === 'next') !== (take.type === 'boolean')) continue;
        command = candidate;
        break choose;
      } catch { /* The final parser supplies the existing actionable usage error. */ }
    }
  }
  const options = { ...OPTIONS,
    ...(['add', 'edit', 'submit', 'done'].includes(command) ? { wait: { type: 'boolean' } } : {}),
    ...(command === 'next' ? { take: { type: 'boolean' } } : {}),
  };
  // Flow consumes a history file; show retains its existing boolean --history switch.
  const commandOptions = command === 'flow' ? { ...options, history: { type: 'string' } } : options;
  return parseArgs({ args: argv, options: commandOptions, allowPositionals: true });
}

/**
 * Run one command. Returns the exit code: 0 done, 1 refused, 2 usage.
 *
 * @param {string[]} argv
 * @param {any} io
 * @returns {Promise<number>}
 */
async function runCommand(argv, io) {
  let parsed;
  try {
    parsed = parseCommandArgs(argv);
  } catch (error) {
    const refusal = new Refused('USAGE', `${error.message}; run pullboard help`);
    await io.prepareRefusal();
    io.refusal?.(refusal);
    io.err(`pullboard: ${error.message}\nRun pullboard help --all for the full list.\nnext: ${io.refusalDocument(refusal).error.next}`);
    return 2;
  }
  const { values, positionals } = parsed;
  io.jsonMode?.(values.json);
  const [command = '', first, second, ...rest] = positionals;
  const args = { first, second, rest, values };
  if ((values.version || command === 'version') && !values.help) return await (await COMMANDS.version()).run(io, args);
  // Help loads only when asked for: a command name other than help, without --help, never needs it.
  const help = !command || command === 'help' || values.help
    ? (await import('./cli-help.js')).selectedHelp(command, first, second, rest, values) : null;
  if (help) return await (await COMMANDS.help()).run(io, args, help);
  try {
    if (values.as === 'person' && !['answer', 'decisions', 'fact', 'hold', 'add', 'edit'].includes(command) && !(command === 'bar' && first === 'sign')) {
      throw new Refused('USAGE', '--as person works with answer, decisions, fact --never-again, hold, add, edit, or bar sign');
    }
    const load = COMMANDS[command];
    if (!load) return (await import('./cli-help.js')).unknownCommand(io, command);
    await (await import('./exit-rules-runtime.js')).enforceExitBoundary(io, command);
    const commandModule = await load();
    if (commandModule.nativeBoardRequired !== false) {
      await io.prepareProcessPorts();
      io.nativeBoard ??= await io.loadNativeBoard();
    }
    return await commandModule.run(io, args);
  } catch (error) {
    error = recordedMoveRefusal(io, error);
    if (error instanceof Refused && error.code === 'RUNNER_TOOLING_CHANGED' && io.submitToolingAttempt?.owned) {
      const { prepareSubmitToolingRetry } = await import('../packages/runners/index.js');
      const selection = prepareSubmitToolingRetry(io.submitToolingAttempt.snapshot, io.submitToolingAttempt);
      if (selection) {
        io.submitToolingAttempt.retry = selection;
        io.submitToolingAttempt.error = error;
        return 1;
      }
    }
    if (error instanceof Refused) {
      io.refusal?.(error);
      io.err(`pullboard: ${await displayedRefusal(io, error)}\nnext: ${io.refusalDocument(error).error.next}`);
      (await import('./next-steps.js')).reportBlock(io, error, { command });
      return 1;
    }
    throw error;
  }
}

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
  if (primary?.branch) (await import('../packages/sandbox/index.js')).trunkRef(info.root, primary.branch);
}

/** Whether a parsed command line only prints version or help, which asks Git nothing. */
function asksGitNothing(argv) {
  try {
    const { values, positionals: [command] } = parseCommandArgs(argv);
    return Boolean(values.help || values.version || command === 'help' || command === 'version');
  } catch { return true; }
}

/**
 * Bind this checkout to the session behind a write before any sync or side effect. Reads, help and authenticated
 * person channels keep their identity and load nothing for it.
 */
async function bindCheckoutSession(io, positionals, values) {
  if (values.help || values.version || io.personChannel === 'view' || io.personRequest) return;
  const [command, first] = positionals;
  if (command === 'takeover' && (positionals.length !== 1 || Object.keys(values).some((key) => key !== 'json'))) {
    throw new Refused('USAGE', 'pullboard takeover takes no arguments; run pullboard takeover [--json]');
  }
  const writes = ['handoff', 'bar', 'init', 'join', 'worktree', 'hooks', 'hook', 'skills', 'add', 'companion', 'edit', 'fact', 'escalate', 'run', 'sweep',
    'next', 'claim', 'hold', 'release', 'submit', 'ship', 'done', 'verify', 'check', 'merged', 'land', 'withdraw', 'refreeze', 'reopen', 'shout', 'answer', 'pass', 'import', 'milestone', 'takeover', 'forget'];
  if (!writes.includes(command) && !(command === 'tool-build' && first === 'promote') && !(command === 'patch' && ['attach', 'remove'].includes(first)) && !(command === 'request' && first && first !== 'list') && !(command === 'lane' && first === 'add') && !(command === 'settings' && first) && !(command === 'spec' && first === 'apply') && !(command === 'relay' && ['on', 'off'].includes(first))) return;
  if (command === 'answer' && values.as === 'person') return;
  await io.prepareProcessPorts();
  io.nativeBoard ??= await io.loadNativeBoard();
  return (await import('./cli.js')).bindWriteSession(io, positionals, values);
}

/** Render a refusal with agents' display names, loading the board only for a refusal that names one. */
async function displayedRefusal(io, error) {
  await io.prepareRefusal();
  const cli = await import('./cli-context.js');
  if (cli.refusalNeedsBoard(error)) io.nativeBoard ??= await io.loadNativeBoard();
  return cli.displayedRefusal(io, error);
}

/** Run one command and emit its single versioned JSON result when requested (A1). */
async function timedMain(argv, streams) {
  if (argv[0] === 'serve' && !startupMainTraced) {
    startupMainTraced = true;
    traceServeStartup('cli-main-enter');
  }
  // Version and help ask Git nothing, so they never load it.
  if (asksGitNothing(argv)) return runMain(argv, streams);
  const { withGitFacts } = await import('./git.js');
  let command;
  try { command = parseCommandArgs(argv).positionals[0]; } catch { /* Normal parsing renders usage. */ }
  if (!['submit', 'done'].includes(command)) return withGitFacts(() => runMain(argv, streams));
  const { captureSubmitTooling, retrySubmitTooling } = await import('../packages/runners/index.js');
  const attempt = { snapshot: captureSubmitTooling(), argv, cwd: streams.cwd ?? process.cwd() };
  const status = await withGitFacts(() => runMain(argv, { ...streams, submitToolingAttempt: attempt }));
  if (!attempt.retry) return status;
  // runMain's finally has released the original checkout lease before a fresh process can bind it.
  try { return await retrySubmitTooling(attempt.retry, argv, streams); }
  catch (error) {
    const output = commandOutput(argv, streams, { loadRefusal: async () => (await import('./next-step-words.js')).refusalDocument });
    await output.prepareRefusal();
    output.refusal(attempt.error);
    output.err(`automatic submit retry could not start (${error.code ?? error.message}); rerun pullboard submit`);
    output.flush(1);
    return 1;
  }
}

/** Record local command wall time without sending timing data to the board. */
export async function main(argv, streams) {
  const { beginSeatTiming, timingSeat } = await import('./seat-timing.js');
  const cwd = streams.cwd ?? process.cwd();
  const item = /^[1-9][0-9]*$/u.test(argv[1] ?? '') ? Number(argv[1]) : null;
  const binding = timingSeat(cwd);
  const finish = beginSeatTiming(cwd, 'command', argv[0] ?? 'help', item, binding);
  const lockPort = Symbol.for('pullboard.seat-timing.lock');
  const previous = globalThis[lockPort];
  globalThis[lockPort] = () => beginSeatTiming(cwd, 'lock-wait', 'board write lock', item, binding);
  try { return await timedMain(argv, streams); } finally { finish(); if (previous) globalThis[lockPort] = previous; else delete globalThis[lockPort]; }
}

/** Parse and execute one CLI command, binding its checkout session and Git-fact scope. */
async function runMain(argv, streams) {
  const io = commandOutput(argv, streams, {
    nextActions: streams.nextActions ?? (process.env.PULLBOARD_TEXT_NEXT !== '0'),
    loadRefusal: async () => (await import('./next-step-words.js')).refusalDocument,
  });
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
  /** Materialize only this invocation's explicit process capabilities, at most once. */
  io.prepareProcessPorts = async () => {
    if (!io.loadProcessPorts) return;
    Object.assign(io, await io.loadProcessPorts());
    io.loadProcessPorts = undefined;
  };
  io.hookWorker = streams.hookWorker;
  io.submitHandoffWorker = streams.submitHandoffWorker;
  /** Bind recursive CLI operations to this process root's native provider. */
  io.runCommand = (args, nextStreams) => main(args, { ...nextStreams, loadProcessPorts: io.loadProcessPorts, loadNativeBoard: io.loadNativeBoard, hookWorker: io.hookWorker, submitHandoffWorker: io.submitHandoffWorker, launchRelaySender: io.launchRelaySender, withOutboxGuard: io.withOutboxGuard, replayConflictRecord: io.replayConflictRecord, remoteBoardMissing: io.remoteBoardMissing, uncertainUploadFailure: io.uncertainUploadFailure, decideUncertainBaseline: io.decideUncertainBaseline, checkpointPublisher: io.checkpointPublisher, relayOrdering: io.relayOrdering, checkpointInBackground: io.checkpointInBackground, scheduleCheckpoint: io.scheduleCheckpoint, requestCheckpointCheck: io.requestCheckpointCheck, checkpointWorker: io.checkpointWorker, openBoard: io.openBoard, nativeBoardPorts: io.nativeBoardPorts, outboxFields: io.outboxFields, outboxPolicy: io.outboxPolicy, flushOutbox: io.flushOutbox, queueMove: io.queueMove, outboxHasPendingCreatedItem: io.outboxHasPendingCreatedItem });
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
      // A coordinator declaration on a linked clone must refuse before auto-link or relay sync.
      && !(command === 'join' && parsed.positionals[1] === (await import('../packages/config/index.js')).COORDINATOR);
    needsRepo = !(parsed.values.help || parsed.values.version || command === 'help' || command === 'version');
  } catch { sync = false; needsRepo = false; }
  // Agent nudges never enter Git-hook identity, synchronization or refusal machinery.
  if (parsed?.positionals[0] === 'hook' && !parsed.values.help && !parsed.values.version
      && !['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push'].includes(parsed.positionals[1])) {
    await io.prepareProcessPorts();
    return (await import('./agent-hook.js')).runAgentHook(io, parsed.positionals[1], io.hookWorker);
  }
  const git = needsRepo ? await import('./git.js') : null;
  git?.setResumeSourceFacts(parsed?.positionals[0] === 'resume');
  if (parsed) {
    try {
      // Checkout identity supplies the display role even if a person-channel check refuses first.
      try { const info = needsRepo ? git.repoInfo(io.cwd) : null; if (info?.isMain) io.caller('coordinator', info.root); } catch { /* Unknown checkouts retain existing guidance. */ }
      let preflightRelay;
      if (parsed.values.as === 'person' && !parsed.values.help && !parsed.values.version) {
        await io.prepareProcessPorts();
        io.nativeBoard ??= await io.loadNativeBoard();
        preflightRelay = await import('./relay.js');
      }
      const [command, verb] = parsed.positionals;
      const remoteRelayOn = command === 'relay' && verb === 'on' && !parsed.values.all;
      if (!parsed.values.help && !parsed.values.version &&
          (parsed.values.as === 'person' && command !== 'decisions' && !await (await import('./person-signing-cli.js')).personMovesSigned(io.cwd, io, { ...preflightRelay, relayStatus: root => preflightRelay.relayStatus(root, io),
            openBoard: (await import('./cli-context.js')).nativeBoardOpeners(io).openBoard }) || command === 'relay' && ['on', 'join', 'revoke', 'members'].includes(verb) && !remoteRelayOn)) {
        (await import('./person.js')).requirePersonChannel(io.personChannel);
        io.caller('person');
      }
      checkoutSession = await bindCheckoutSession(io, parsed.positionals, parsed.values);
      if (checkoutSession?.lease) CHECKOUT_LEASES.set(io, checkoutSession.lease);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      io.refusal(error);
      io.err(`pullboard: ${await displayedRefusal(io, error)}\nnext: ${io.refusalDocument(error).error.next}`);
      (await import('./next-steps.js')).reportBlock(io, error, { command: parsed.positionals[0] });
      io.flush(1);
      return 1;
    }
  }
  try {
    if (needsRepo) {
      await rememberTrunk(io, git);
    }
    traceServeStartup('cli-command-preamble-start');
    // The relay and baseline work loads only where a relay token, relay state, a link or a pending result exists.
    /** Load the work around the command when any of it could act here, or null. */
    const syncWork = async () => {
      if (!sync || !(await import('../packages/store/index.js')).syncMayAct(io.cwd)) return null;
      await io.prepareProcessPorts();
      io.nativeBoard ??= await io.loadNativeBoard();
      return import('./cli-sync.js');
    };
    await (await syncWork())?.syncBefore(io, io.runCommand);
    traceServeStartup('cli-command-preamble-ready');
    const code = await runCommand(argv, io);
    if (io.submitToolingAttempt?.retry) return code;
    auditAfterCommand = code === 0 && ((parsed?.positionals[0] === 'land'
      && !parsed.values['dry-run'] && parsed.values.waive === undefined)
      || (parsed?.positionals[0] === 'merged' && parsed.values['gate-receipt'] !== undefined));
    advanceAfterCommand = code === 0 && !parsed.values['dry-run'] && (auditAfterCommand
      || parsed.positionals[0] === 'merged' || parsed.positionals[0] === 'sentinel' && parsed.positionals[1] === 'run');
    if (code === 0) {
      await checkoutSession?.finish?.();
    }
    if (code === 0) await (await syncWork())?.retrySync(io);
    const status = io.exitCode(code);
    if (status === 0 && needsRepo && !parsed?.values['dry-run'] && parsed?.positionals[0] !== 'maintenance') {
      // The foreground command already read this configuration; disabled maintenance adds no second context read.
      maintenanceAfterCommand = io.worktreeMaintenanceContext;
      automaticLandingAfterCommand = io.automaticLandingContext;
    }
    if (status === 0 && needsRepo && !parsed?.values['dry-run'] && parsed?.positionals[0] !== 'tool-build') toolBuildGateAfterCommand = io.toolBuildGateContext;
    if (status === 0 && needsRepo && !parsed?.values['dry-run']) (await import('../packages/items/index.js')).clearCompletedBlocks(io, { requirePersonChannel: (await import('./person.js')).requirePersonChannel });
    if (status !== 0) await io.prepareRefusal();
    io.flush(status);
    return status;
  } finally {
    CHECKOUT_LEASES.delete(io);
    CHECKOUT_BOARD_ONLY.delete(io);
    checkoutSession?.lease?.release();
    if (automaticLandingAfterCommand) {
      try { await (await import('../packages/landing/index.js')).recoverAutomaticLanding(automaticLandingAfterCommand.info.root, new URL('../bin/automatic-landing.js', import.meta.url)); }
      catch (error) { io.err(`automatic landing wake unavailable: ${error.code ?? error.name}: ${error.message}`); }
    }
    if (maintenanceAfterCommand) {
      try { await (await import('./worktree-maintenance-scheduler.js')).scheduleWorktreeMaintenance(maintenanceAfterCommand); }
      catch (error) { io.err(maintenanceTimerWarning(error)); }
    }
    if (toolBuildGateAfterCommand) {
      try { await (await import('./tool-build-scheduler.js')).scheduleToolBuildGate(toolBuildGateAfterCommand); }
      catch (error) { io.err(`tool build gate timer unavailable: ${error.code ?? error.name}`); }
    }
    if (advanceAfterCommand) {
      try {
        let eligible = true;
        try {
          const { landingLeaseState } = await import('./board-landing-lease.js');
          eligible = (await import('../packages/sandbox/index.js')).hasSourceAdvanceJobs(io.cwd, { landingLeaseState,
            openBoardForRead: (await import('./cli-context.js')).nativeBoardOpeners(io).openBoardForRead });
        }
        catch { /* Unknown state keeps the normal worker path, which records incomplete work. */ }
        await (await import('../packages/git/index.js')).nudgeSourceAdvances(io.cwd, {
          workerUrl: new URL('../bin/source-advance.js', import.meta.url), eligible,
        });
      }
      catch { io.err('pullboard: the automatic main-merge worker could not start; run pullboard sentinel run --health-only to retry'); }
    }
    if (auditAfterCommand) {
      try { await (await import('./main-audit-nudge.js')).nudgeMainAudit(io.cwd, new URL('../bin/main-audit.js', import.meta.url)); }
      catch { io.err('pullboard: the full-suite audit could not start; run pullboard land again to retry'); }
    }
  }
}

// This marker is emitted once when the actual CLI entrypoint finishes evaluating.
if (process.env.PULLBOARD_STARTUP_TRACE_ENTRY
  && resolve(process.argv[1] ?? '') === resolve(process.env.PULLBOARD_STARTUP_TRACE_ENTRY)) {
  traceServeStartup('cli-module-load-complete');
}
