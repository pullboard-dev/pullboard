/** The pullboard view command, in its own module so an item adding another command never edits these lines. */
import {
  launchBackgroundView,
  reportView,
} from '../background-view.js';
import {
  CONFIG_FILE,
  loadConfig,
} from '../config.js';
import {
  codeIsFromMain,
  repoInfo,
} from '../git.js';
import {
  listApiProjects,
  registerProjectAndLink,
} from '../projects.js';
import {
  Refused,
} from '../refused.js';
import {
  startServeSentinel,
} from '../serve-sentinel.js';
import {
  exportView,
  serveView,
} from '../serve.js';
import {
  defaultViewPort,
} from '../view-port.js';
import {
  busyViewPortRefusal,
  forgetView,
  rememberView,
  runningView,
} from '../view-session.js';
import {
  spawn,
} from '../windows-child-process.js';
import {
  existsSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  context,
  recordViewBind,
  recordViewReuse,
  withBoard,
} from '../cli.js';

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
  if (values.export !== undefined) {
    if (values.project || values.lan) throw new Refused('USAGE', 'choose either a live view with --project or --lan, or --export for a static snapshot');
    const exported = await exportView(io.cwd, resolve(io.cwd, values.export));
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
    } else if (info.isMain && existsSync(join(info.root, CONFIG_FILE))) {
      await registerProjectAndLink(info.root, new Date(), loadConfig(info.root), io);
    }
  } catch (error) {
    if (projectRequested && error instanceof Refused && error.code !== 'PROJECT_NOT_REGISTERED') {
      throw new Refused('PROJECT_NOT_REGISTERED', 'run pullboard view --project inside a registered project repository or linked worktree, or use plain pullboard view for every project');
    }
    if (!(error instanceof Refused)) throw error;
    if (projectRequested) throw error;
  }
  const internalForeground = process.env.PULLBOARD_VIEW_BACKGROUND_CHILD === '1'
    || process.env.PULLBOARD_VIEW_FOREGROUND === '1';
  if (!internalForeground) {
    const existing = !lan && port ? await runningView(port, scopeCommonDir) : null;
    if (existing) {
      if (info && existsSync(join(info.root, CONFIG_FILE))) {
        const ctx = context(io);
        withBoard(ctx, board => recordViewReuse(ctx, board, existing));
      }
      reportView(io, { ...existing, reused: true });
      return 0;
    }
    if (process.env.AI_AGENT !== undefined || !io.physicalStdoutIsTTY) return await launchBackgroundView(io, port, projectRoot, { lan });
  }
  let view;
  try {
    // The adapter override is carried only by the in-process command streams, for private CLI fixtures.
    view = await (io.serveView ?? serveView)({ port, isMain: codeIsFromMain(), ...(lan ? { lan: true } : {}), ...(projectRoot ? { projectRoot } : {}) });
    const sentinel = startServeSentinel({ projectRoot });
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
    if (info && existsSync(join(info.root, CONFIG_FILE))) {
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
    if (process.env.PULLBOARD_VIEW_BACKGROUND_CHILD === '1' && process.send) {
      process.send({ type: 'startup-error', code: error.code ?? 'VIEW_START', message: error.message });
    }
    throw error;
  }
  reportView(io, { ...view, reused: false });
  if (process.env.PULLBOARD_VIEW_BACKGROUND_CHILD === '1' && process.send) {
    process.send({ type: 'ready', url: view.url, port: view.port, pid: process.pid, boundAt: view.boundAt, ...(lan ? { lan: true } : {}) });
  }
  io.flush?.(0);
  if (!values['no-open'] && process.env.PULLBOARD_VIEW_BACKGROUND_CHILD !== '1') {
    const opener = process.platform === 'darwin' ? ['open', [view.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', view.url]] : ['xdg-open', [view.url]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
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
