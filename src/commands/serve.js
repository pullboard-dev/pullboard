/** The pullboard serve command, in its own module so an item adding another command never edits these lines. */
import {
  serveApi,
} from '../api.js';
import { performanceCores } from '../gate.js';
import { refusalDocument } from '../next-step-words.js';
import {
  traceServeStartup,
} from '../cli-main.js';
import {
  DEFAULT_VIEW_PORT,
  defaultViewPort,
  loadConfig,
} from '../config.js';
import {
  git,
} from '../git.js';
import {
  registerProjectAndLink,
} from '../projects.js';
import {
  Refused,
} from '../refused.js';
import {
  context,
  main,
} from '../cli.js';

/** Serve API v1 until a shutdown signal, printing its address before waiting (A2). */
export async function serveHere(io, values) {
  traceServeStartup('serve-context-start');
  const ctx = context(io);
  traceServeStartup('serve-context-ready');
  const mainRoot = git(ctx.info.root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice('worktree '.length);
  traceServeStartup('serve-registration-start');
  await registerProjectAndLink(mainRoot, new Date(), loadConfig(mainRoot), io);
  traceServeStartup('serve-registration-ready');
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refused('USAGE', '--port is a number from 0 to 65535; use 0 to choose a free one');
  traceServeStartup('serve-listen-start');
  const api = await serveApi({ port, runCommand: main, isMain: ctx.allowSchemaUpgrade, refusalDocument,
    settingsProviders: { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT } });
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

/** Run `pullboard serve` and return its exit code. */
export async function run(io, { values }) {
  return await serveHere(io, values);
}
