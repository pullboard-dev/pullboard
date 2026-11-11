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
import { performanceCores } from '../../../../../packages/gate/index.js';
import { refusalDocument } from '../../logic/step/words.js';
import {
  traceServeStartup,
} from '../main.js';
import { serveListen } from '../../../../../packages/config/index.js';
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
  traceServeStartup('serve-listen-start');
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: nativeBoardOpeners(io), port, address, runCommand: io.runCommand, isMain: ctx.allowSchemaUpgrade, refusalDocument,
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
  await new Promise((stop) => {
    const stopped = () => { process.off('SIGINT', stopped); process.off('SIGTERM', stopped); stop(); };
    process.once('SIGINT', stopped);
    process.once('SIGTERM', stopped);
  });
  await api.close();
  return 0;
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
