/** The pullboard view command, in its own module so an item adding another command never edits these lines. */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { fileURLToPath } from 'node:url';
import {
  launchBackgroundView,
  reportView,
} from '../../../../view/index.js';
import {
  CONFIG_FILE,
  loadConfig,
} from '../../../../../packages/config/index.js';
import {
  codeIsFromMain,
  repoInfo,
} from '../../../../../packages/git/index.js';
import {
  listApiProjects,
  registerProjectAndLink,
} from '../../../../../packages/seats/index.js';
import { projectLinkPorts } from '../ports/project.js';
import { assertPublicExportSupported } from '../../logic/exports.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  startServeSentinel,
} from '../../../../../packages/sentinels/index.js';
import {
  exportView as exportProvidedView,
  serveView as serveProvidedView,
} from '../../../../view/index.js';
import {
  defaultViewPort,
} from '../../../../../packages/config/index.js';
import {
  busyViewPortRefusal,
  forgetView,
  rememberView,
  runningView,
} from '../../../../view/index.js';
import {
  spawn,
} from 'node:child_process';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import {
  join,
  resolve,
} from 'node:path';
import { cockpitPage } from '../cockpit/renderer.js';
import { nativeBoardOpeners } from '../context.js';
import * as nativeBoard from '../../../../lib/index.js';
import { refusalDocument } from '../../logic/step/words.js';
import {
  context,
  recordViewBind,
  recordViewReuse,
  withBoard,
} from '../entry.js';

const fs = fileSystemAdapter();

/** Serve the local page with the CLI authority supplied by its higher-level caller [N26]. */
export function serveView(options = {}) {
  // The state module pullboard serve hands its materializer, so the view reads resident state instead of rebuilding it.
  return serveProvidedView({ refusalDocument, boardOpeners: nativeBoardOpeners({ nativeBoard }), statePorts: new URL('./serve.js', import.meta.url).href, ...options, renderPage: cockpitPage });
}

/** Export the page with the same command authority and renderer used by the live view [N26]. */
export function exportView(root, directory, options = {}) {
  return exportProvidedView(root, directory, { refusalDocument, boardOpeners: nativeBoardOpeners({ nativeBoard }), ...options, renderPage: cockpitPage });
}

// The checked exporter owns this capability; the composition preserves its public-export guard.
exportView.supportsPublicExport = exportProvidedView.supportsPublicExport;

/**
 * \`pullboard view\` (N26): serve the micro site for every project on this machine until stopped,
 * registering the repo it starts in, and open it in the browser unless asked not to. With --export,
 * write the current board's read-only static snapshot instead, and return its folder.
 *
 * @param {any} io
 * @param {any} values
 * @returns {Promise<number>}
 */
export async function viewHere(io, values) {
  if (values.public && values.export === undefined) {
    throw new Refused('USAGE', '--public requires --export for a static public snapshot');
  }
  if (values.export !== undefined) {
    if (values.project || values.lan) throw new Refused('USAGE', 'choose either a live view with --project or --lan, or --export for a static snapshot');
    const exporter = io.exportView ?? exportView;
    if (values.public) assertPublicExportSupported(exporter);
    const exported = values.public
      ? await exporter(io.cwd, resolve(io.cwd, values.export), { public: true, runCommand: io.runCommand, boardOpeners: nativeBoardOpeners(io), refusalDocument })
      : await exporter(io.cwd, resolve(io.cwd, values.export), { runCommand: io.runCommand, boardOpeners: nativeBoardOpeners(io), refusalDocument });
    io.result?.(exported);
    io.say(`wrote snapshot ${exported.path}`);
    return 0;
  }
  const projectRequested = Boolean(values.project);
  const lan = Boolean(values.lan);
  const port = values.port === undefined ? (projectRequested || lan ? 0 : defaultViewPort()) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refused('USAGE', '--port is a number from 0 to 65535; 0 picks a free one');
  let projectRoot;
  let scopeCommonDir;
  let info;
  try {
    info = repoInfo(io.cwd);
    if (projectRequested) {
      const projects = listApiProjects();
      const matches = projects.filter((project) => {
        try { return repoInfo(project.root).commonDir === info.commonDir; }
        catch { return false; }
      });
      if (matches.length !== 1) throw new Refused('PROJECT_NOT_REGISTERED', 'run pullboard view --project inside a registered project repository or linked worktree, or use plain pullboard view for every project');
      projectRoot = matches[0].root;
      scopeCommonDir = info.commonDir;
    } else if (info.isMain && fs.exists(join(info.root, CONFIG_FILE))) {
      await registerProjectAndLink(info.root, new Date(), loadConfig(info.root), io, undefined, projectLinkPorts(io));
    }
  } catch (error) {
    if (projectRequested && error instanceof Refused && error.code !== 'PROJECT_NOT_REGISTERED') {
      throw new Refused('PROJECT_NOT_REGISTERED', 'run pullboard view --project inside a registered project repository or linked worktree, or use plain pullboard view for every project');
    }
    if (!(error instanceof Refused)) throw error;
    if (projectRequested) throw error;
  }
  const internalForeground = environmentAdapter().get('PULLBOARD_VIEW_BACKGROUND_CHILD') === '1'
    || environmentAdapter().get('PULLBOARD_VIEW_FOREGROUND') === '1';
  if (!internalForeground) {
    const existing = !lan && port ? await runningView(port, scopeCommonDir) : null;
    if (existing) {
      if (info && fs.exists(join(info.root, CONFIG_FILE))) {
        const ctx = context(io);
        withBoard(ctx, board => recordViewReuse(ctx, board, existing));
      }
      reportView(io, { ...existing, reused: true });
      return 0;
    }
    if (environmentAdapter().get('AI_AGENT') !== undefined || !io.physicalStdoutIsTTY) return await launchBackgroundView(io, port, projectRoot, { lan });
  }
  let view;
  try {
    // The adapter override is carried only by the in-process command streams, for private CLI fixtures.
    view = await (io.serveView ?? serveView)({ port, runCommand: io.runCommand, boardOpeners: nativeBoardOpeners(io), refusalDocument, isMain: codeIsFromMain(), ...(lan ? { lan: true } : {}), ...(projectRoot ? { projectRoot } : {}) });
    const sentinel = startServeSentinel({ projectRoot, cli: fileURLToPath(new URL('../../../pullboard.js', import.meta.url)) });
    const boundAt = new Date().toISOString();
    const closeServer = view.close;
    view = {
      ...view,
      ...(lan ? { lan: true } : {}),
      pid: process.pid,
      boundAt,
      close: async () => { await sentinel.close(); if (!lan) forgetView(view.port); await closeServer(); },
    };
    try {
      if (!lan) rememberView({ port: view.port, secret: new URL(view.url).searchParams.get('k'), pid: process.pid, boundAt,
        ...(scopeCommonDir ? { scopeCommonDir } : {}) }, { rememberPort: port === 0 && !scopeCommonDir });
    } catch (error) {
      throw new Refused('VIEW_STATE', `could not save the private view session: ${error.message}`);
    }
    // Only a successful fresh bind writes this board's typed setup receipt.
    let info;
    try { info = repoInfo(io.cwd); }
    catch (error) { if (!(error instanceof Refused)) throw error; }
    if (info && fs.exists(join(info.root, CONFIG_FILE))) {
      const ctx = context(io);
      withBoard(ctx, board => recordViewBind(ctx, board, boundAt));
    }
  } catch (error) {
    if (view) await view.close();
    if (error instanceof Refused && error.code === 'PORT_BUSY') {
      // pullboard.dev only looks on the default port, so a busy default names the holder to stop.
      // The background child is handed --port explicitly, so the default is matched by number.
      let hosted = false;
      try { hosted = port !== 0 && port === defaultViewPort(); } catch { /* A malformed override names no default port. */ }
      error = busyViewPortRefusal(port, hosted);
    }
    if (environmentAdapter().get('PULLBOARD_VIEW_BACKGROUND_CHILD') === '1' && process.send) {
      process.send({ type: 'startup-error', code: error.code ?? 'VIEW_START', message: error.message });
    }
    throw error;
  }
  reportView(io, { ...view, reused: false });
  if (environmentAdapter().get('PULLBOARD_VIEW_BACKGROUND_CHILD') === '1' && process.send) {
    process.send({ type: 'ready', url: view.url, port: view.port, pid: process.pid, boundAt: view.boundAt, ...(lan ? { lan: true } : {}) });
  }
  io.flush?.(0);
  if (!values['no-open'] && environmentAdapter().get('PULLBOARD_VIEW_BACKGROUND_CHILD') !== '1') {
    // The OS URL opener, named as literals so the browser census can see it never starts Chrome itself (#2021).
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', view.url] : [view.url];
    spawn(opener, openerArgs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  await new Promise((stop) => {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await view.close();
  return 0;
}

/** Run `pullboard view` and return its exit code. */
export async function run(io, { values }) {
  return await viewHere(io, values);
}
