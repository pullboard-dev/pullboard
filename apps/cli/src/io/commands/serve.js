import { viewApiPorts } from '../../../../view/index.js';
import { nativeBoardOpeners } from '../context.js';
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

/** Serve API v1 until a shutdown signal, printing its address before waiting (A2). */
export async function serveHere(io, values) {
  traceServeStartup('serve-context-start');
  const ctx = context(io);
  traceServeStartup('serve-context-ready');
  const mainRoot = git(ctx.info.root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice('worktree '.length);
  traceServeStartup('serve-registration-start');
  await registerProjectAndLink(mainRoot, new Date(), loadConfig(mainRoot), io, undefined, projectLinkPorts(io));
  traceServeStartup('serve-registration-ready');
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refused('USAGE', '--port is a number from 0 to 65535; use 0 to choose a free one');
  traceServeStartup('serve-listen-start');
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: nativeBoardOpeners(io), port, runCommand: io.runCommand, isMain: ctx.allowSchemaUpgrade, refusalDocument,
    settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }, statePorts: import.meta.url });
  traceServeStartup('serve-listen-ready');
  io.result?.({ url: api.url, port: api.port });
  io.say(`Pullboard API v1: ${api.url}`);
  io.say('Only this machine can reach it, with its session secret. Ctrl-C stops it.');
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
