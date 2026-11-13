import { viewApiPorts } from '../../../../view/index.js';
import { nativeBoardOpeners } from '../context.js';
import { withBoardRead } from '../context.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { openBoardForRead } from '../../../../lib/index.js';
import { loadKeyedResult } from '../../../../../packages/pin/index.js';
import { saveKeyedResult } from '../../../../../packages/pin/index.js';
import { savedKeyedResults } from '../../../../../packages/pin/index.js';
/** The pullboard serve command, in its own module so an item adding another command never edits these lines. */
import {
  serveApi,
} from '../../../../../packages/api/index.js';
import { apiBoards } from '../../../../../packages/api/index.js';
import { restartOnCodeMove } from '../../../../../packages/drive/index.js';
import { servedModuleMoved } from '../../../../../packages/drive/index.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnReachable } from '../../../../../packages/jobs/index.js';
import { pullboardHome } from '../../../../../packages/store/index.js';
import { servedTrunkPack } from '../../../../../packages/runners/index.js';
import { performanceCores } from '../../../../../packages/gate/index.js';
import { refusalDocument } from '../../logic/step/words.js';
import {
  traceServeStartup,
} from '../main.js';
import { serveListen } from '../../../../../packages/config/index.js';
import { mainComparisonMode } from '../../../../../packages/config/index.js';
import { criterionMainReceipts } from '../submit/receipt.js';
import { provideMainComparison } from '../../../../../packages/api/index.js';
import { provideBaselineRecorder } from '../../../../../packages/api/index.js';
import { provideMainTestRecorder } from '../../../../../packages/api/index.js';
import { recordPulledBaseline } from '../../../../../packages/gate/index.js';
import { recordMainTestReceipt } from '../../../../../packages/landing/index.js';
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
  // Off loopback the API answers runners on the network: it needs this machine's lasting board key and serves only this repo's board [P7].
  const networked = address !== LOOPBACK;
  // A pulled gate's red cases are read against main's receipts like a submit gate's, unless gate.mainComparison is off [P7].
  provideMainComparison(request => mainComparisonMode() === 'off' ? null : criterionMainReceipts(request));
  provideMainTestRecorder(recordMainTestReceipt);
  provideBaselineRecorder(recordPulledBaseline);
  traceServeStartup('serve-listen-start');
  // The board's own checkout serves one cached trunk pack per commit to cold runners [C7].
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: { ...nativeBoardOpeners(io), trunkPack: servedTrunkPack }, port, address, runCommand: io.runCommand, isMain: ctx.allowSchemaUpgrade, refusalDocument,
    ...(networked ? { secret: boardKey(), scope: { projectRoot: mainRoot } } : {}),
    settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }, statePorts: import.meta.url });
  traceServeStartup('serve-listen-ready');
  // The one board served off loopback, by the address runner serve and install-serve take.
  const boards = networked ? [withBoardRead(ctx, board => store.boardId(board))].map(id => ({ id, runnerUrl: `${new URL(api.url).origin}/api/v1/boards/${id}` })) : [];
  io.result?.({ url: api.url, port: api.port, address, ...(networked ? { boards, keyFile: boardKeyFile() } : {}) });
  io.say(`Pullboard API v1: ${api.url}`);
  if (!networked) io.say('Only this machine can reach it, with its session secret. Ctrl-C stops it.');
  for (const board of boards) io.say(`Runners pull from ${board.runnerUrl} with the key in ${boardKeyFile()}:\n  pullboard runner install-serve <ssh-host> --board ${board.runnerUrl}`);
  if (networked) io.say(`Any computer that can reach ${address} and holds the board key can use this board. Ctrl-C stops it.`);
  io.flush?.(0);
  traceServeStartup('serve-ready-written');
  // A landing that moves this checkout restarts the API on the new code and the same port (#6157).
  const log = join(pullboardHome(), 'serve.log');
  const fresh = restartOnCodeMove({ root: CODE_ROOT, revision: () => codeCommit(), close: api.close,
    affects: servedModuleMoved({ root: CODE_ROOT, entries: [join(CODE_ROOT, 'apps/cli/pullboard.js'), fileURLToPath(import.meta.url)] }), log: (line) => process.stderr.write(`${line}; the new process logs to ${log}\n`),
    relaunch: () => spawnReachable(process.execPath, sameServe(api.port), { cwd: process.cwd(), log }) });
  const restarted = await new Promise((stop) => {
    const stopped = (moved) => { process.off('SIGINT', stopped); process.off('SIGTERM', stopped); stop(moved === true); };
    process.once('SIGINT', stopped);
    process.once('SIGTERM', stopped);
    fresh.restarted.then(() => stopped(true));
  });
  fresh.stop();
  if (!restarted) await api.close();
  return 0;
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
 * The board API on loopback for the boards `projects` lists, composed as `pullboard serve` composes it, for the local
 * runner [P7]. boards() names each board's id, read once per board.
 *
 * @param {object} io
 * @param {{ projects: () => Array<{ root: string, name: string, project: string, added: string }>, secret: string }} options
 */
export async function loopbackBoardApi(io, { projects, secret }) {
  const ctx = context(io), openers = { ...nativeBoardOpeners(io), trunkPack: servedTrunkPack }, ids = new Map();
  provideMainComparison(request => mainComparisonMode() === 'off' ? null : criterionMainReceipts(request));
  provideMainTestRecorder(recordMainTestReceipt);
  provideBaselineRecorder(recordPulledBaseline);
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: openers, port: 0, address: LOOPBACK, secret, runCommand: io.runCommand, isMain: ctx.allowSchemaUpgrade,
    refusalDocument, projects, settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }, statePorts: import.meta.url });
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

/** Run `pullboard serve` and return its exit code. */
export async function run(io, { values }) {
  return await serveHere(io, values);
}
