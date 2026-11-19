import { recordRunnerMeasurement } from '../../../../../packages/config/index.js';
/** The pullboard runner command, in its own module so an item adding another command never edits these lines. */
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  addRunner,
  loadMachineSettings,
  removeRunner,
  setRunnerDrain,
} from '../../../../../packages/config/index.js';
import {
  recordRunnerGui,
  runnerResourceStatus,
} from '../../../../../packages/resources/index.js';
import { parseToolchains } from '../../../../../packages/config/index.js';
import { validateRunner } from '../../../../../packages/config/index.js';
import { probeRunnerTransport } from '../../../../../packages/runners/index.js';
import { readPulledCapacity } from '../../../../../packages/runners/index.js';
import { lastRecordedLimit } from './stats/limits.js';
import { recordLimitChange } from './stats/limits.js';
import { boardRunsReader } from '../../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../../packages/store/index.js';
import { atomic } from '../../../../../packages/store/index.js';
import { logEvent } from '../../../../../packages/store/index.js';
import { context } from '../read.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';
import { createHostedItemFolder } from '../../../../../packages/runners/index.js';
import { serveRunner } from '../../../../../packages/drive/index.js';
import { runnerSettingNumber } from '../../../../../packages/drive/index.js';
import { runnerSettingOn } from '../../../../../packages/drive/index.js';
import { machineSettingsFile } from '../../../../../packages/resources/index.js';
import { localRunnerStatus } from '../../../../../packages/drive/index.js';
import { localRunnerFolder } from '../runner/local.js';
import { pullGit } from '../runner/git.js';
import { installRunnerService } from '../../../../../packages/runners/index.js';
import { serviceBoard } from '../../../../../packages/runners/index.js';
import { boardKey } from '../../../../../packages/config/index.js';
import { boardKeyFile } from '../../../../../packages/config/index.js';
import { asyncFetchEnabled } from '../../../../../packages/config/index.js';
import { pulledProfilePathsEnabled } from '../../../../../packages/config/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { issueRunnerKey } from '../../../../../packages/runners/index.js';
import { revokeRunnerKey } from '../../../../../packages/runners/index.js';
import {
  computeRunnerSlots,
  effectiveRunner,
} from '../../../../../packages/runners/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
const fs = fileSystemAdapter();

/** How long runner add waits for the one-time registration probe (SSH, a shell and node on the runner); health probes keep their 3 s default so a loaded runner or slow link still registers [C7]. */
const REGISTRATION_PROBE_MS = 15_000;

/** The runners the board sees live (serves that claimed within minutes), or undefined when it sees none or cannot be read. Why here: it is the board's one reader of pulled capacity [U151]. */
export function liveRunnerCount(ctx) {
  try {
    const { totals } = withBoardRead(ctx, board => readPulledCapacity(board.db, { runs: boardRunsReader(board, ctx.file) }));
    return totals.serves > 0 ? totals.serves : undefined;
  } catch { return undefined; }
}

/** Describe one runner's measured size and the slots the gate offers from it. */
function sizeLine(runner, settings) {
  if (runner.cores === undefined) return 'not measured (registered counts apply); run pullboard runner measure';
  const offered = effectiveRunner(runner, settings.gate?.measuredSlots === true);
  const formula = computeRunnerSlots(runner);
  return `${runner.cores} cores, ${runner.memoryMB} MB; formula ${formula.slots} slots, ${formula.browser} browser`
    + (runner.fixed === true ? '; declared count overrides' : settings.gate?.measuredSlots === true ? `; offering ${offered.slots}` : '; gate.measuredSlots is off');
}

/** One line naming a toolchain the runner's probe could not verify, with what was declared and what the runner answered [C7]. */
function toolchainLine(host, problem) {
  const want = problem.declared === '' ? 'any version' : `declared ${problem.declared}`;
  return problem.problem === 'missing' ? `runner ${host}: toolchain ${problem.name} is missing (${want})`
    : `runner ${host}: toolchain ${problem.name} is the wrong version (${want}, found ${problem.found})`;
}

/** List, add or remove machine-level SSH capacity without requiring a board identity or runner account. */
export async function runnerCommand(io, { first, second, rest, values }, { serve = serveRunner } = {}) {
  if (first === 'list') {
    if (second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'pullboard runner list');
    // Registered capacity is what each runner enforces, whatever its own settings say (#1066).
    const settings = loadMachineSettings();
    const registered = new Map((settings.runners ?? []).map(runner => [runner.host, runner]));
    const runners = runnerResourceStatus(settings.runners ?? []).map(row => {
      const runner = registered.get(row.host);
      if (!runner) return { ...row, computedSlots: null };
      const offered = effectiveRunner(runner, settings.gate?.measuredSlots === true);
      return { ...row, slots: offered.slots, browser: offered.browser,
        ...(runner.cores !== undefined ? { cores: runner.cores, memoryMB: runner.memoryMB, measuredAt: runner.measuredAt } : {}),
        computedSlots: runner.cores !== undefined ? computeRunnerSlots(runner).slots : null,
        fixed: runner.fixed === true, ...(runner.drain === true ? { draining: true } : {}) };
    });
    // The auto-started local runner is no registered runner, so it is named from its own state file [P7].
    const folder = localRunnerFolder();
    const local = localRunnerStatus(folder);
    io.result?.({ runners, ...(local ? { local } : {}) });
    const localLine = local ? (local.state === 'live' ? `local (pid ${local.pid}, live)` : 'local (stopped)') : null;
    if (localLine && !runners.length) { io.say(localLine); return 0; }
    io.say(runners.length ? [...(localLine ? [localLine] : []), ...runners.map(runner => `${runner.host}: ${runner.slots} slots, ${runner.browser} browser${runner.draining ? ' (draining)' : ''}\n  size: ${registered.has(runner.host) ? sizeLine(registered.get(runner.host), settings) : 'draining'}\n  GUI session: ${runner.gui === true ? 'yes' : runner.gui === false ? 'no' : 'unknown'}`)].join('\n') : 'no runners registered');
    return 0;
  }
  if (first === 'status') {
    // Pulled-job capacity from the board's job table: claimed jobs against each serve's declared jobs setting [#5993].
    if (second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'pullboard runner status [--json]');
    const ctx = context(io);
    if (!fs.exists(ctx.file)) throw new Refused('NO_BOARD', 'there is no board here', 'run pullboard runner status inside a board repository');
    const db = openBoardReadOnly(ctx.file);
    let capacity;
    try { capacity = readPulledCapacity(db, { runs: boardRunsReader({ db }, ctx.file) }); } finally { db.close(); }
    io.result?.(capacity);
    io.say(capacity.serves.length ? [...capacity.serves.map(entry => `${entry.runner}: ${entry.claimed} of ${entry.jobs ?? 'unknown'} jobs`),
      `fleet: ${capacity.totals.claimed} of ${capacity.totals.jobs} jobs`].join('\n') : 'no serves have claimed pulled jobs');
    return 0;
  }
  if (first === 'key') {
    // The board's runner key book: issue a key to a named runner, or revoke it, kept in the board folder [C7].
    const usage = 'pullboard runner key issue <runner> | pullboard runner key revoke <runner>';
    if (!['issue', 'revoke'].includes(second) || rest.length !== 1 || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', usage);
    const ctx = context(io);
    const folder = dirname(ctx.file);
    /** The book's plain errors carry a rule code and next step: wear them as refusals. */
    const wear = work => { try { return work(); } catch (error) { throw error?.code && !(error instanceof Refused) ? new Refused(error.code, error.message, error.next) : error; } };
    if (second === 'revoke') {
      const { revoked } = wear(() => revokeRunnerKey(folder, rest[0]));
      io.result?.({ runner: rest[0], revoked });
      io.say(`revoked runner ${rest[0]}'s key; its pulls are refused, also after a board restart`);
      return 0;
    }
    const issued = wear(() => issueRunnerKey(folder, rest[0]));
    io.result?.(issued);
    io.say(`issued a key to runner ${issued.runner}; the board trusts public key ${issued.publicKey}\nprivate key (shown once, keep it on the runner): ${issued.privateKey}`);
    return 0;
  }
  if (first === 'serve') {
    // A pull runner: only outbound HTTPS to the board and git fetches from its trunk remote, no ssh in [P7].
    if (!second || rest.length || Object.keys(values).some(key => !['json', 'as', 'key', 'directory', 'once', 'jobs'].includes(key))) {
      throw new Refused('USAGE', 'pullboard runner serve <board-url> [--as <runner-id>] [--key <board-key>] [--directory <cache>] [--jobs <n>] [--once]');
    }
    // A serve started with a different --jobs than the last one recorded on this machine's board is a change to the limits in effect (#6139).
    const open = work => withBoard(context(io), work);
    if (Number.isSafeInteger(Number(values.jobs))) recordLimitChange(open, 'runner.jobs', lastRecordedLimit(open, 'runner.jobs'), Number(values.jobs), { atomic, logEvent });
    const stop = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stop.abort());
    const served = await serve({ board: second, key: values.key ?? process.env.PULLBOARD_BOARD_KEY, runner: values.as,
      ...(values.directory ? { cache: values.directory } : {}), ...(values.jobs !== undefined ? { jobs: values.jobs } : {}), once: values.once === true, handlers: { land: landJobHandler }, git: pullGit, signal: stop.signal, say: line => io.say(line),
      fetchFailFast: runnerSettingOn(machineSettingsFile(), 'runners.fetchFailFast'), drainOnFetchFailure: runnerSettingOn(machineSettingsFile(), 'runners.drainOnFetchFailure'),
      fetchConcurrent: runnerSettingOn(machineSettingsFile(), 'runners.fetchConcurrent'),
      pruneYields: runnerSettingOn(machineSettingsFile(), 'runners.yieldWhilePruning'),
      postedLineNamesCase: runnerSettingOn(machineSettingsFile(), 'runners.postedLineNamesCase'), pulledProfilePaths: pulledProfilePathsEnabled(),
      jobWorkerFactor: runnerSettingNumber(machineSettingsFile(), 'runners.jobWorkerFactor', 2) })
      .catch(error => { throw error?.code && !(error instanceof Refused) ? new Refused(error.code, error.message) : error; });
    io.result?.(served);
    return 0;
  }
  if (first === 'local') {
    // The machine's own runner: the board API on loopback and runner serve against it, started by a pull submit [P7].
    if (second || rest.length || Object.keys(values).some(key => !['json', 'off'].includes(key))) throw new Refused('USAGE', 'pullboard runner local [--off]');
    return (await import('../runner/local/serve.js')).localRunnerCommand(io, { off: values.off === true });
  }
  if (first === 'install-serve') {
    // Deploy pull mode: runner serve as a launchd service on the runner, restarting on exit, so no ssh is needed afterwards [P7].
    const usage = 'pullboard runner install-serve <ssh-host> --board <board-url> [--key <board-key>] | pullboard runner install-serve <ssh-host> --remove';
    if (!second || rest.length || Object.keys(values).some(key => !['json', 'board', 'key', 'remove'].includes(key))
      || (values.remove ? values.board !== undefined || values.key !== undefined : typeof values.board !== 'string')) throw new Refused('USAGE', usage);
    const runner = (loadMachineSettings().runners ?? []).find(entry => entry.host === second);
    if (!runner) throw new Refused('RUNNER_NOT_REGISTERED', `runner ${second} is not registered`, 'run pullboard runner add <ssh-host>');
    // The key: the flag, the URL's own ?k=, the runner environment's variable, or this machine's board key when it serves the board.
    const key = values.key ?? (values.remove ? undefined : serviceBoard(values.board).key) ?? process.env.PULLBOARD_BOARD_KEY
      ?? (fs.exists(boardKeyFile()) ? boardKey() : undefined);
    const service = await installRunnerService(runner, values.remove ? { remove: true } : { board: values.board, key });
    io.result?.({ service });
    if (values.remove) {
      io.say(`removed runner serve from ${runner.host}`);
      if (service.sudo) io.say(`a LaunchDaemon is still installed; to remove it, on ${runner.host} run: ${service.sudo}`);
      return 0;
    }
    if (service.form === 'daemon') {
      // A board on the local network: macOS Local Network privacy lets a LaunchDaemon run as the runner user through.
      io.say(`runner serve on ${runner.host} is a LaunchDaemon ${service.label} run as ${service.user}, since macOS Local Network privacy blocks a LaunchAgent from the board's local network address; log ${service.log}`);
      if (!service.loaded) io.say(`one step left, as an administrator: on ${runner.host} run: ${service.sudo}`);
      return service.loaded ? 0 : 1;
    }
    io.say(`installed runner serve on ${runner.host} as launchd agent ${service.label}, restarting on exit; log ${service.log}`);
    if (service.sudo) io.say(`an older LaunchDaemon is still installed; on ${runner.host} run: ${service.sudo}`);
    if (!service.loaded) io.say(`launchd did not load it now (no login session?); it starts at the next login, or run on the runner: launchctl bootstrap gui/$(id -u) ${service.plist}`);
    return service.loaded ? 0 : 1;
  }
  if (first === 'remove') {
    if (!second || second.trim() !== second || rest.length || Object.keys(values).some(key => key !== 'json')) {
      throw new Refused('USAGE', 'pullboard runner remove <ssh-host>');
    }
    const runner = removeRunner(second);
    io.result?.({ runner });
    io.say(`${runner.draining ? 'draining' : 'removed'} runner ${runner.host}`);
    return 0;
  }
  if (first === 'drain' || first === 'undrain') {
    if (!second || second.trim() !== second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', `pullboard runner ${first} <ssh-host>`);
    const runner = setRunnerDrain(second, first === 'drain');
    io.result?.({ runner, draining: first === 'drain' });
    io.say(first === 'drain' ? `draining runner ${runner.host}: it takes no new job, its running jobs finish; return it with pullboard runner undrain ${runner.host}`
      : `runner ${runner.host} is back in rotation`);
    return 0;
  }
  if (first === 'measure') {
    if (rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'pullboard runner measure [<ssh-host>]');
    const registered = loadMachineSettings().runners ?? [];
    const targets = second === undefined ? registered : registered.filter(runner => runner.host === second);
    if (!targets.length) throw new Refused('RUNNER_NOT_REGISTERED', second === undefined ? 'no runners are registered' : `runner ${second} is not registered`, 'run pullboard runner list');
    const measured = [];
    for (const target of targets) {
      const observation = await probeRunnerTransport(target, { observeGui: true, ...(target.toolchains ? { toolchains: target.toolchains } : {}) });
      for (const problem of observation.toolchains?.problems ?? []) io.say(toolchainLine(target.host, problem));
      if (observation.cores === undefined) { io.say(`runner ${target.host}: measurement failed (${observation.reason}); its recorded size is unchanged`); measured.push({ host: target.host, measured: false }); continue; }
      let runner;
      try { runner = recordRunnerMeasurement(target.host, { gui: observation.gui, cores: observation.cores, memoryMB: observation.memoryMB, measuredAt: new Date().toISOString() }); }
      catch (error) {
        if (error?.code !== 'RUNNER_BUSY') throw error;
        io.say(`runner ${target.host}: ${error.message}; measure it again when idle`); measured.push({ host: target.host, measured: false }); continue;
      }
      recordRunnerGui(runner.host, observation.gui);
      io.say(`measured runner ${runner.host}: ${sizeLine(runner, loadMachineSettings())}`);
      measured.push({ host: runner.host, measured: true, cores: runner.cores, memoryMB: runner.memoryMB, ...computeRunnerSlots(runner) });
    }
    io.result?.({ measured });
    return measured.some(entry => !entry.measured) ? 1 : 0;
  }
  const slotsGiven = values.slots !== undefined;
  if (first !== 'add' || !second || rest.length || slotsGiven && !/^[1-9]\d*$/u.test(values.slots)
    || values.browser !== undefined && !/^(?:0|[1-9]\d*)$/u.test(values.browser)
    || slotsGiven && values.browser === undefined || !slotsGiven && values.browser !== undefined && Number(values.browser) !== 0) {
    throw new Refused('USAGE', 'pullboard runner add <ssh-host> [--slots <positive integer>] [--browser <integer from zero through slots>] [--toolchain node=22,python=3.12|auto] | pullboard runner measure [<ssh-host>]');
  }
  const prior = (loadMachineSettings().runners ?? []).find(runner => runner.host === second);
  const node = values.node ?? prior?.node;
  const root = values.root ?? prior?.root;
  // A re-registration keeps the declared toolchains unless it declares new ones.
  const auto = values.toolchain === 'auto';
  const toolchains = auto ? undefined : values.toolchain !== undefined ? parseToolchains(values.toolchain) : prior?.toolchains;
  const probed = validateRunner({ host: second, slots: 1, browser: 0,
    ...(node !== undefined ? { node } : {}), ...(root !== undefined ? { root } : {}) });
  const observation = await probeRunnerTransport(probed, { observeGui: true, discoverNode: node === undefined, enrollSigningKey: true, timeoutMs: REGISTRATION_PROBE_MS, ...(toolchains ? { toolchains } : {}), ...(auto ? { discover: true } : {}) });
  if (!observation.healthy) throw new Refused('RUNNER_SETUP', `runner ${second} did not complete its registration probe; fix the SSH connection or configured Node, then run pullboard runner add again`);
  if (typeof observation.publicKey !== 'string') throw new Refused('RUNNER_SETUP', `runner ${second} did not enroll its result signing key; check its Pullboard home permissions, then run pullboard runner add again`);
  if (node === undefined && !observation.nodePath) throw new Refused('RUNNER_SETUP', `runner ${second} did not report an absolute Node path from its login shell; install Node or pass --node <absolute-path>`);
  if (node === undefined) probed.node = observation.nodePath;
  const measuredSize = observation.cores !== undefined ? { cores: observation.cores, memoryMB: observation.memoryMB, measuredAt: new Date().toISOString() } : {};
  // Without --slots the runner's own measurement sets the count; a declared --slots is fixed and always wins.
  if (!slotsGiven && observation.cores === undefined) throw new Refused('RUNNER_NOT_MEASURED', `runner ${second} did not report its cores and memory (${observation.reason}); fix the SSH connection or declare --slots <n> --browser <n>`);
  const sized = slotsGiven ? { slots: Number(values.slots), browser: Number(values.browser), fixed: true }
    : { ...computeRunnerSlots(measuredSize), ...(values.browser === '0' ? { browser: 0 } : {}) };
  if (sized.slots === 0) throw new Refused('BAD_RUNNER', `runner ${second} has no capacity after the core and memory reserves; use a larger runner or an explicit fixed count`);
  // Only the toolchains the runner's own probe answered are recorded; each one it could not verify is named and left out.
  const verified = auto ? observation.discovered ?? {} : toolchains ? observation.toolchains?.verified ?? {} : undefined;
  if (auto) io.say(Object.keys(verified).length ? `runner ${second}: found toolchains ${Object.entries(verified).map(([name, version]) => `${name} ${version}`).join(', ')}` : `runner ${second}: --toolchain auto found no toolchain; none recorded`);
  for (const problem of toolchains ? observation.toolchains?.problems ?? Object.keys(toolchains).map(name => ({ name, problem: 'missing', declared: toolchains[name], found: null })) : []) io.say(toolchainLine(second, problem));
  const configured = validateRunner({ ...probed, ...sized, ...measuredSize, publicKey: observation.publicKey, ...(verified && Object.keys(verified).length ? { toolchains: verified } : {}) });
  const runner = addRunner({ ...configured, gui: observation.gui });
  recordRunnerGui(runner.host, observation.gui);
  io.result?.({ runner });
  io.say(`registered runner ${runner.host}: ${runner.slots} slots, ${runner.browser} browser; GUI session: ${runner.gui === true ? 'yes' : runner.gui === false ? 'no' : 'unknown (registration probe unavailable)'}`);
  return 0;
}

/** Run `pullboard runner` and return its exit code. */
export function run(io, args) {
  return runnerCommand(io, args);
}

/**
 * The registered runner a runner-hosted seat keeps its item folders on, or null for a seat with local folders [C7].
 * A seat is runner-hosted when its environment names a registered runner in PULLBOARD_ITEM_FOLDER_RUNNER.
 * @param {NodeJS.ProcessEnv} [env] The seat's environment.
 * @returns {{ host: string, builderRoot?: string, root?: string }|null} The runner record, or null.
 */
export function itemFolderRunner(env = process.env) {
  const host = env.PULLBOARD_ITEM_FOLDER_RUNNER?.trim();
  if (!host) return null;
  const runner = (loadMachineSettings().runners ?? []).find(row => row.host === host);
  if (!runner) throw new Refused('RUNNER_NOT_REGISTERED', `item folder runner ${host} is not registered`, 'run pullboard runner list, or unset PULLBOARD_ITEM_FOLDER_RUNNER');
  return runner;
}

/**
 * Create or renew the item folder on the seat's runner over ssh; the coordinator repository gains no worktree [C7].
 * The runner clones from PULLBOARD_ITEM_FOLDER_ORIGIN, or from the coordinator's Git directory when unset.
 * @param {{ host: string }} runner The registered runner.
 * @param {{ itemId: number, branch: string, commonDir: string, hooksPath?: string }} plan The item, its branch, the coordinator's Git directory and its hooks path.
 * @param {NodeJS.ProcessEnv} [env] The seat's environment.
 * @returns {Promise<string>} The folder as host:path.
 */
export async function openHostedItemFolder(runner, { itemId, branch, commonDir, hooksPath }, env = process.env) {
  const hosted = await createHostedItemFolder(runner, { itemId, origin: env.PULLBOARD_ITEM_FOLDER_ORIGIN?.trim() || commonDir,
    branch, ...(hooksPath ? { hooksPath } : {}) });
  return `${hosted.host}:${hosted.folder}`;
}

/** A pulled land job, run in the runner's own landing checkout under its cache: merge, check, push trunk by compare-and-swap [P7]. */
async function landJobHandler(claim, { cache, renew, env }) {
  const { runLandingJob } = await import('../../../../../packages/landing/index.js');
  const { diagnoseLandingRed } = await import('./flakes.js');
  return runLandingJob(claim.payload, { workdir: join(cache, 'land'), renew, env, diagnose: diagnoseLandingRed, asyncFetch: asyncFetchEnabled() });
}
