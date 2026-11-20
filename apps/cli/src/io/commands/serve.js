import { viewApiPorts } from '../../../../view/index.js';
import { nativeBoardOpeners } from '../context.js';
import { moveArgs } from '../../../../../packages/person/index.js';
import { receiveMoveCommits as receiveCommits } from '../submit/pushed.js';
import { withBoardRead } from '../context.js';
import { withBoard } from '../context.js';
import { serveReconciler } from '../reconcile.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { openBoardForRead } from '../../../../lib/index.js';
import { nativeBoardPorts } from '../../../../lib/index.js';
import { loadKeyedResult } from '../../../../../packages/pin/index.js';
import { saveKeyedResult } from '../../../../../packages/pin/index.js';
import { savedKeyedResults } from '../../../../../packages/pin/index.js';
/** The pullboard serve command, in its own module so an item adding another command never edits these lines. */
import {
  serveApi,
} from '../../../../../packages/api/index.js';
import { apiBoards } from '../../../../../packages/api/index.js';
import { poolHandlers } from '../../../../../packages/api/index.js';
import { restartOnCodeMove } from '../../../../../packages/drive/index.js';
import { claimTrial } from '../../../../../packages/drive/index.js';
import { trialClaims } from '../../../../../packages/api/index.js';
import { serveRestartTrial } from '../../../../../packages/config/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { servedModuleMoved } from '../../../../../packages/drive/index.js';
import { startLoopWatchdog } from '../../../../../packages/drive/index.js';
import { announceListening } from '../../../../../packages/drive/index.js';
import { catchListeners } from '../../../../../packages/drive/index.js';
import { inheritedListener } from '../../../../../packages/drive/index.js';
import { spawnOnSocket } from '../../../../../packages/drive/index.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boardPullAdapter } from '../../../../../packages/runners/index.js';
import { pullHandler } from '../../../../../packages/runners/index.js';
import { jobsPullPorts } from '../../../../../packages/jobs/index.js';
import { checkSignedResult } from '../../../../../packages/landing/index.js';
import { servePullRoute } from '../../../../../packages/config/index.js';
import { spawnReachable } from '../../../../../packages/jobs/index.js';
import { pullboardHome } from '../../../../../packages/store/index.js';
import { servedTrunkPack } from '../../../../../packages/runners/index.js';
import { performanceCores } from '../../../../../packages/gate/index.js';
import { refusalDocument } from '../../logic/step/words.js';
import {
  traceServeStartup,
} from '../main.js';
import { serveListen } from '../../../../../packages/config/index.js';
import { movesShadowEnabled } from '../../../../../packages/config/index.js';
import { movesLiveEnabled } from '../../../../../packages/config/index.js';
import { mainComparisonMode } from '../../../../../packages/config/index.js';
import { excuseMainTimingReds } from '../../../../../packages/config/index.js';
import { criterionMainReceipts } from '../submit/receipt.js';
import { provideMainComparison } from '../../../../../packages/api/index.js';
import { provideTimingExcuse } from '../../../../../packages/api/index.js';
import { provideGateHopTable } from '../../../../../packages/api/index.js';
import { provideJobTable } from '../../../../../packages/api/index.js';
import { JOB_MAX_ATTEMPTS } from '../../../../../packages/api/index.js';
import { jobEngine } from '../../../../../packages/moves/index.js';
import { runTable } from '../../../../../packages/moves/index.js';
import { LEASE_MS } from '../../../../../packages/jobs/index.js';
import { gateHopTable } from '../submit/hop.js';
import { provideCompanionInheritance } from '../../../../../packages/api/index.js';
import { provideMainRedNotes } from '../../../../../packages/api/index.js';
import { provideRefusalTrials } from '../../../../../packages/api/index.js';
import { provideComparisonStart } from '../../../../../packages/api/index.js';
import { provideLandingStart } from '../../../../../packages/api/index.js';
import { provideScreenStart } from '../../../../../packages/api/index.js';
import { providePostLandMainTest } from '../../../../../packages/api/index.js';
import { providePostLandPullOut } from '../../../../../packages/api/index.js';
import { runScreenJob } from '../../../../../packages/drive/index.js';
import { machineryRefusal } from '../../../../../packages/gate/heavy.js';
import { countTrialGate } from '../../../../../packages/gate/heavy.js';
import { provideBaselineRecorder } from '../../../../../packages/api/index.js';
import { provideMainTestRecorder } from '../../../../../packages/api/index.js';
import { recordPulledBaseline } from '../../../../../packages/gate/heavy.js';
import { recordMainTestReceipt } from '../../../../../packages/landing/index.js';
import { mainRedMessage } from '../../../../../packages/landing/index.js';
import { companionMainFailuresUntouched } from '../../../../../packages/landing/index.js';
import { boardKey } from '../../../../../packages/config/index.js';
import { boardKeyFile } from '../../../../../packages/config/index.js';
import {
  DEFAULT_VIEW_PORT,
  defaultViewPort,
  loadConfig,
} from '../../../../../packages/config/index.js';
import {
  git,
} from '../../../../../packages/git/index.js';
import { gitChildEnv } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import {
  registerProjectAndLink,
} from '../../../../../packages/seats/index.js';
import { projectLinkPorts } from '../ports/project.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  context,
  main,
} from '../entry.js';

/** The address `pullboard serve` keeps when no setting or flag names another. */
const LOOPBACK = '127.0.0.1';

/** The ledger port for a pulled gate's machinery diagnostics: the board repository's refusal-trial ledger, as the inline gate kept it [C7]. */
const pulledRefusalTrials = { refuse: machineryRefusal, count: countTrialGate };

/**
 * What `pullboard serve` prints first: the address, that it answers JSON and no page, and the command that shows the view [C7].
 *
 * @param {string} url - The API's printed address.
 * @returns {string[]}
 */
export function serveBanner(url) {
  return [`Pullboard API v1 (JSON only, it has no page): ${url}`, 'To see the board in a browser, run: pullboard view'];
}

/**
 * The request handler that answers runner pulls at /pull/, or null while serve.pullRoute is off.
 *
 * Why: the pull adapter had no caller outside tests; mounting it here, behind a setting that is off, lets a board host
 * serve runners that dial out without changing what serve answers for anyone who has not turned it on (#8765). The
 * lease and record ports are the job table's (#8764); the bundle port is a stub until the tree-to-bundle slice (#9316).
 *
 * @param {{ folder: string, openDb: () => import('node:sqlite').DatabaseSync, enabled?: boolean }} options - The board folder, the opener of a connection to the board's job table, and the setting's value.
 * @returns {((request: object, response: object) => Promise<void>) | null} A request handler taking the Node HTTP request and response, or null.
 */
export function pullRouteHandler({ folder, openDb, enabled = servePullRoute() }) {
  if (!enabled) return null;
  const db = openDb();
  return pullHandler(boardPullAdapter({ folder, ...jobsPullPorts(db), checkResult: checkSignedResult, bundle: () => null }));
}

/** Serve API v1 until a shutdown signal, printing its address before waiting (A2). */
export async function serveHere(io, values) {
  traceServeStartup('serve-context-start');
  const ctx = context(io);
  traceServeStartup('serve-context-ready');
  const mainRoot = git(ctx.info.root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice('worktree '.length);
  traceServeStartup('serve-registration-start');
  await registerProjectAndLink(mainRoot, new Date(), loadConfig(mainRoot), io, undefined, projectLinkPorts(io));
  traceServeStartup('serve-registration-ready');
  const flagPort = values.port === undefined ? undefined : Number(values.port);
  if (flagPort !== undefined && (!Number.isInteger(flagPort) || flagPort < 0 || flagPort > 65535)) throw new Refused('USAGE', '--port is a number from 0 to 65535; use 0 to choose a free one');
  const { address, port } = serveListen({ address: values.address, port: flagPort });
  // A replacement started by a restart listens on its predecessor's socket, handed to it as a descriptor (#6723).
  const inherited = inheritedListener();
  // Off loopback the API answers runners on the network: it needs this machine's lasting board key and serves only this repo's board [P7].
  const networked = address !== LOOPBACK;
  // A pulled gate's red cases are read against main's receipts like a submit gate's, unless gate.mainComparison is off [P7].
  provideMainComparison(request => mainComparisonMode() === 'off' ? null : criterionMainReceipts(request));
  provideTimingExcuse(() => excuseMainTimingReds());
  provideGateHopTable(gateHopTable);
  provideJobTable(jobShadowTable(), movesShadowEnabled, () => movesLiveEnabled('job'));
  provideCompanionInheritance(companionMainFailuresUntouched);
  provideMainTestRecorder(recordMainTestReceipt);
  provideMainRedNotes(MAIN_RED_NOTES);
  provideBaselineRecorder(recordPulledBaseline);
  provideRefusalTrials(pulledRefusalTrials);
  provideComparisonStart(startPulledComparison);
  provideLandingStart(startReceiptLanding);
  provideScreenStart(startReceiptScreen);
  providePostLandMainTest((await import('../test/post-land.js')).postLandTestRequest);
  providePostLandPullOut(startPostLandPullOut);
  traceServeStartup('serve-listen-start');
  // serve.pullRoute (off by default): runners that dial out pull jobs through this API's /pull/ routes [C7,#8765].
  const pullRoute = pullRouteHandler({ folder: dirname(ctx.file), openDb: () => { const db = new DatabaseSync(ctx.file); db.exec('PRAGMA busy_timeout = 5000'); return db; } });
  // The board's own checkout serves one cached trunk pack per commit to cold runners [C7].
  // serveApi passes `port` to server.listen, which takes the inherited { fd } in its place.
  const listening = await catchListeners(() => serveApi({ viewPorts: viewApiPorts, boardOpeners: { ...nativeBoardOpeners(io), launchRelaySender: io.launchRelaySender, trunkPack: servedTrunkPack }, port: inherited ?? port, address, runCommand: io.runCommand, isMain: ctx.allowSchemaUpgrade, refusalDocument, pullRoute: pullRoute ?? undefined,
    ...(networked ? { secret: boardKey(), scope: { projectRoot: mainRoot } } : {}),
    settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }, statePorts: import.meta.url, handlerPorts: import.meta.url, watchdog: startLoopWatchdog }));
  const api = listening.value;
  if (inherited) announceListening();
  traceServeStartup('serve-listen-ready');
  // The one board served off loopback, by the address runner serve and install-serve take.
  const boards = networked ? [withBoardRead(ctx, board => store.boardId(board))].map(id => ({ id, runnerUrl: `${new URL(api.url).origin}/api/v1/boards/${id}` })) : [];
  io.result?.({ url: api.url, port: api.port, address, ...(networked ? { boards, keyFile: boardKeyFile() } : {}) });
  for (const line of serveBanner(api.url)) io.say(line);
  if (!networked) io.say('Only this machine can reach it, with its session secret. Ctrl-C stops it.');
  for (const board of boards) io.say(`Runners pull from ${board.runnerUrl} with the key in ${boardKeyFile()}:\n  pullboard runner install-serve <ssh-host> --board ${board.runnerUrl}`);
  if (networked) io.say(`Any computer that can reach ${address} and holds the board key can use this board. Ctrl-C stops it.`);
  io.flush?.(0);
  traceServeStartup('serve-ready-written');
  // With the board's runs_store flag on, the loop settles board-and-runs disagreements at most once every 5 s; off, it opens no runs file [B2,P7].
  const reconciler = serveReconciler({ withBoard: work => withBoard(ctx, work), boardFile: ctx.file, onError: error => process.stderr.write(`reconciler tick failed: ${error.message}\n`) });
  // A landing that moves this checkout restarts the API on the new code and the same port (#6157).
  // Where the socket can be handed on, the new process listens before this one stops accepting, so no request is refused (#6723).
  const log = join(pullboardHome(), 'serve.log');
  const socket = listening.socketFd(api.port);
  // With serve.restartTrial on, a move is first tried on the claim path: this process's own claims against the new code's (#12118).
  const trial = serveRestartTrial() ? claimTrial({ claims: trialClaims, db: ctx.file, root: ctx.info.root, next: newCodeClaims }) : null;
  const fresh = restartOnCodeMove({ root: CODE_ROOT, revision: () => codeCommit(), handoff: socket !== null, trial,
    close: socket !== null ? () => listening.drain(api.port).then(api.close) : api.close,
    affects: servedModuleMoved({ root: CODE_ROOT, entries: [join(CODE_ROOT, 'apps/cli/pullboard.js'), fileURLToPath(import.meta.url)] }), log: (line) => process.stderr.write(`${line}; the new process logs to ${log}\n`),
    relaunch: () => socket !== null ? spawnOnSocket(process.execPath, sameServe(api.port), { fd: socket, cwd: process.cwd(), log }) : spawnReachable(process.execPath, sameServe(api.port), { cwd: process.cwd(), log }) });
  const restarted = await new Promise((stop) => {
    const stopped = (moved) => { process.off('SIGINT', stopped); process.off('SIGTERM', stopped); stop(moved === true); };
    process.once('SIGINT', stopped);
    process.once('SIGTERM', stopped);
    fresh.restarted.then(() => stopped(true));
  });
  fresh.stop();
  reconciler.stop();
  if (!restarted) await api.close();
  return 0;
}

/** The trial claims run by the code now in this checkout (the new commit), in a child process so this one's loaded code is not the one measured. */
async function newCodeClaims(_to, { db, root, count }) {
  const module = pathToFileURL(join(CODE_ROOT, 'packages/api/src/io/claim-replay.js')).href;
  const script = `const m = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(m.trialClaims({ db: ${JSON.stringify(db)}, root: ${JSON.stringify(root)}, count: ${count} })))`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: CODE_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

/** The checkout this CLI's code runs from. */
const CODE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The commit the CLI's checkout is at, or null outside a Git checkout. */
function codeCommit() {
  const read = tryGit(CODE_ROOT, ['rev-parse', 'HEAD'], { env: gitChildEnv(CODE_ROOT) });
  return read.status === 0 ? read.stdout.trim() : null;
}

/** This process's own serve arguments, pinned to the port it holds, so a restart answers at the same address. */
function sameServe(port) {
  const args = process.argv.slice(2).filter((arg, index, all) => arg !== '--port' && all[index - 1] !== '--port' && !arg.startsWith('--port='));
  return [...process.execArgv, process.argv[1], ...args, '--port', String(port)];
}

/**
 * Detach a green pulled submission's background comparison, as the inline green submit does; false when
 * gate.mainComparison is off. The worker loads with the first green gate, so a board that never compares pays nothing [C7,V4].
 * @param {{ root: string, item: number, source: string, digest: string }} request
 */
function startPulledComparison(request) {
  if (mainComparisonMode() === 'off') return false;
  return import('./verify.js').then(module => module.launchPulledComparison(request)).catch(() => { /* A comparison is observation only. */ });
}

/**
 * Run the pull-out of the sprint items a red main-wide test receipt reopened: revert each landing on the trunk and record it pulled.
 * Why: the reopen writes pull_out, and only a land job offer started the landing wake, so the work stayed on main [M2,R3,#12184].
 * @param {{ root: string, items: number[] }} request
 */
export async function startPostLandPullOut({ root, items }) {
  const [{ wakeIo }, { pullOutPulling }] = await Promise.all([import('../landing/automatic.js'), import('../landing/pull-out.js')]);
  return pullOutPulling(context(wakeIo(root)), items);
}

/**
 * Offer the land job for an item a gate receipt left accepted, as `verify accept` offers it, from the board host's main
 * checkout. Why: a carried merge-only accept runs no verify command, so without this its item waited accepted with no
 * land job (#7948). The lander loads with the first such receipt.
 * @param {{ root: string, item: number }} request
 */
export async function startReceiptLanding({ root }) {
  const [{ wakeIo }, { landAfterAcceptance }] = await Promise.all([import('../landing/automatic.js'), import('./land.js')]);
  return landAfterAcceptance(context(wakeIo(root)));
}

/**
 * Run the screen for a sprint item a gate receipt just recorded as submitted: merge its commit onto the trunk tip the gate ran
 * on, run the board's staticChecks and the trusted commit re-check, and store the receipt as a screen job on the board.
 * Why: a sprint item lands after a green screen instead of an accept, and nothing ran one, so it waited like a steady item.
 * The board API calls this only for a sprint item; the re-check loads with the first screen [V2,M1].
 * @param {{ root: string, item: number, commit: string, digest: string | null, trunk: string }} request
 */
export async function startReceiptScreen({ root, item, commit, digest, trunk }) {
  const [{ wakeIo }, { recheckRange }] = await Promise.all([import('../landing/automatic.js'), import('../../../../../packages/commits/index.js')]);
  const ctx = context(wakeIo(root));
  return withBoard(ctx, board => runScreenJob(board.db, { repo: root, item: { id: item, pace: 'sprint', commit, digest }, base: trunk,
    owner: `serve:${process.pid}`, staticCommand: typeof ctx.config.staticChecks === 'string' ? ctx.config.staticChecks : null, recheck: recheckRange }));
}

/** The inline gate's main-red wording, which pulled gate facts name an inherited red's owning rework with [V1,C7]. */
const MAIN_RED_NOTES = { message: (root, board, comparison) => mainRedMessage(root, board, null, comparison) };

/**
 * The board API on loopback for the boards `projects` lists, composed as `pullboard serve` composes it, for the local
 * runner [P7]. boards() names each board's id, read once per board.
 *
 * @param {object} io
 * @param {{ projects: () => Array<{ root: string, name: string, project: string, added: string }>, secret: string }} options
 */
export async function loopbackBoardApi(io, { projects, secret }) {
  const ctx = context(io), openers = { ...nativeBoardOpeners(io), launchRelaySender: io.launchRelaySender, trunkPack: servedTrunkPack }, ids = new Map();
  provideMainComparison(request => mainComparisonMode() === 'off' ? null : criterionMainReceipts(request));
  provideTimingExcuse(() => excuseMainTimingReds());
  provideGateHopTable(gateHopTable);
  provideJobTable(jobShadowTable(), movesShadowEnabled, () => movesLiveEnabled('job'));
  provideCompanionInheritance(companionMainFailuresUntouched);
  provideMainTestRecorder(recordMainTestReceipt);
  provideMainRedNotes(MAIN_RED_NOTES);
  provideBaselineRecorder(recordPulledBaseline);
  provideRefusalTrials(pulledRefusalTrials);
  provideComparisonStart(startPulledComparison);
  provideLandingStart(startReceiptLanding);
  provideScreenStart(startReceiptScreen);
  providePostLandMainTest((await import('../test/post-land.js')).postLandTestRequest);
  providePostLandPullOut(startPostLandPullOut);
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: openers, port: 0, address: LOOPBACK, secret, runCommand: io.runCommand, isMain: ctx.allowSchemaUpgrade,
    refusalDocument, projects, settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }, statePorts: import.meta.url, handlerPorts: import.meta.url, watchdog: startLoopWatchdog });
  const boards = () => {
    const unread = projects().filter(project => !ids.has(project.root));
    if (unread.length) for (const board of apiBoards(() => unread, ctx.allowSchemaUpgrade, openers)) ids.set(board.root, board.id);
    return projects().filter(project => ids.has(project.root)).map(project => ({ root: project.root, id: ids.get(project.root) }));
  };
  return { origin: new URL(api.url).origin, key: secret, boards, close: api.close };
}

/**
 * The ports the state worker builds with, the view's projections and the native board openers, and the store it
 * saves board snapshots in, the pin cell's keyed results; composed inside the worker thread, which cannot be handed
 * functions from the request thread [A2,C7].
 */
export function boardStatePorts() {
  return { viewPorts: viewApiPorts, boardOpeners: { openBoard, openBoardForRead },
    snapshotStore: { load: loadKeyedResult, save: saveKeyedResult, saved: savedKeyedResults } };
}

/** The job table the writer's shadow compare decides with, over the jobs cell's lease and the api's claim cap, so each stays one source [C7,#8381]. */
function jobShadowTable() {
  const { rules, table } = jobEngine({ leaseMs: LEASE_MS, maxAttempts: JOB_MAX_ATTEMPTS });
  return (snapshot, move) => runTable(table, rules, snapshot, move);
}

/**
 * The ports the API's handler pool workers run with: the native board openers, and the gate's main comparison and
 * main-test and baseline recorders a posted receipt reaches; provided inside each worker thread, which cannot be
 * handed functions from the request thread [A2,C7].
 */
export async function boardHandlerPorts({ isMain } = {}) {
  provideMainComparison(request => mainComparisonMode() === 'off' ? null : criterionMainReceipts(request));
  provideTimingExcuse(() => excuseMainTimingReds());
  provideGateHopTable(gateHopTable);
  provideJobTable(jobShadowTable(), movesShadowEnabled, () => movesLiveEnabled('job'));
  provideCompanionInheritance(companionMainFailuresUntouched);
  provideMainTestRecorder(recordMainTestReceipt);
  provideMainRedNotes(MAIN_RED_NOTES);
  provideBaselineRecorder(recordPulledBaseline);
  provideRefusalTrials(pulledRefusalTrials);
  provideComparisonStart(startPulledComparison);
  provideLandingStart(startReceiptLanding);
  provideScreenStart(startReceiptScreen);
  providePostLandMainTest((await import('../test/post-land.js')).postLandTestRequest);
  providePostLandPullOut(startPostLandPullOut);
  // A move runs the CLI as the standalone `pullboard` does, loaded when the first move reaches this worker [A2,C7].
  const runCommand = async (args, streams) => {
    const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import('../ports/process.js');
    return main(args, { ...streams, loadNativeBoard, loadProcessPorts, gateWaitReporter });
  };
  // A receipt on a relay-linked board queues its moves in the relay outbox, so the worker carries the relay ports too (#7562).
  const { loadProcessPorts } = await import('../ports/process.js');
  const boardOpeners = { ...await loadProcessPorts(), moveArgs, receiveCommits, openBoard, openBoardForRead, nativeBoardPorts };
  return { handlers: poolHandlers({ boardOpeners }, { isMain, runCommand, refusalDocument }) };
}

/** Run `pullboard serve` and return its exit code. */
export async function run(io, { values }) {
  return await serveHere(io, values);
}
