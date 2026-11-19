/** The relay serves the existing cockpit over a device-only decrypting transport [H5,H15]. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../../cli/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { MACHINE } from '../../../../../packages/state/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { lex } from '../../../../../packages/kernel/index.js';
import { APPROVAL_CARD_STYLES } from '../../logic/browser/card.js';
import { composeViewStyles } from '../../../../view/light.js';
import { relayScreenMarkup } from './notice.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fileSystem = fileSystemAdapter();

const STYLES = composeViewStyles() + APPROVAL_CARD_STYLES;

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * The browser modules served by a fixed public name, each read from its exact body. Relay files import one another by
 * these names; every other module they reach is served at its repository path below MODULE_PREFIX.
 */
const BROWSER_MODULES = {
  '/relay/install.js': new URL('../../logic/browser/install.js', import.meta.url),
  '/relay/device-keys.js': new URL('../../../../../packages/keys/src/logic/device.js', import.meta.url),
  '/relay/relay-approval.js': new URL('../../../../../packages/link/src/logic/relay/approval.js', import.meta.url),
  '/relay/browser-devices.js': new URL('./devices.js', import.meta.url),
  '/relay/browser-excluded.js': new URL('../../logic/browser/excluded.js', import.meta.url),
  '/relay/excluded-notice.js': new URL('../../logic/notice.js', import.meta.url),
  '/relay/browser-approval-card.js': new URL('../../logic/browser/card.js', import.meta.url),
  '/relay/browser-passkeys.js': new URL('./passkeys.js', import.meta.url),
  '/relay/client.js': new URL('./client.js', import.meta.url),
  '/relay/person-pairing-limit.js': new URL('../../../../../packages/person/src/io/pairing/limit.js', import.meta.url),
  '/relay/person-enrollment.js': new URL('../../../../../packages/person/src/logic/enrollment.js', import.meta.url),
  '/relay/relay-limits.js': new URL('../../../../../packages/link/src/logic/relay/limits.js', import.meta.url),
  '/relay/browser-notice.js': new URL('./notice.js', import.meta.url),
  '/relay/browser-upload-status.js': new URL('../../logic/browser/status.js', import.meta.url),
  '/relay/browser-deadline.js': new URL('../../logic/browser/deadline.js', import.meta.url),
  '/relay/browser-adapter.js': new URL('../browser-adapter.js', import.meta.url),
  '/relay/browser-stream.js': new URL('../../logic/browser/stream.js', import.meta.url),
  '/relay/browser-pages.js': new URL('../../logic/browser/pages.js', import.meta.url),
  '/relay/browser-history.js': new URL('./history.js', import.meta.url),
  '/relay/page-layout.js': new URL('../../../../../packages/pages/src/logic/relay/layout.js', import.meta.url),
  '/relay/sealed-pages.js': new URL('../../../../../packages/pages/src/logic/sealed.js', import.meta.url),
  '/relay/model.js': new URL('./model.js', import.meta.url),
  '/relay/lifecycle-move.js': new URL('../../../../../packages/items/src/logic/lifecycle.js', import.meta.url),
  '/relay/seal.js': new URL('../../../../../packages/kernel/src/logic/seal.js', import.meta.url),
  '/relay/person-bar-effect.js': new URL('../../../../../packages/person/src/logic/effect.js', import.meta.url),
  '/relay/person-request.js': new URL('../../../../../packages/person/src/logic/request.js', import.meta.url),
  '/relay/refused.js': new URL('../../../../../packages/kernel/src/logic/refused.js', import.meta.url),
};

/**
 * Modules a browser must not load, with what it reads instead: a public URL, or the exact body behind a shim or a front
 * door that has no pure core.js. A cell front door with a pure core.js is read as that core.js without an entry here.
 */
const BROWSER_STANDINS = {
  'packages/keys/index.js': new URL('../../../../../packages/keys/src/logic/device.js', import.meta.url),
  // The moved relay limits read PAIR_PACKAGE_BYTES through the person door; its pure core.js does not carry that body.
  'packages/person/index.js': new URL('../../../../../packages/person/src/io/pairing/limit.js', import.meta.url),
  // The kernel door also carries Node-only pieces (machineHome imports node:path); a browser module reads the browser-safe pure.js instead, which exports every name a page imports.
  'packages/kernel/index.js': new URL('../../../../../packages/kernel/browser.js', import.meta.url),
  'packages/kernel/light.js': new URL('../../../../../packages/kernel/browser.js', import.meta.url),
};

/** The kernel doors no browser may load as written, each read as the browser-safe door. */
const KERNEL_BROWSER_DOORS = {
  'packages/kernel/index.js': 'packages/kernel/browser.js',
  'packages/kernel/light.js': 'packages/kernel/browser.js',
};

/** Where a module the browser reaches by repository path is served; its directory structure is kept, so relative imports resolve. */
export const MODULE_PREFIX = '/relay/m/';

/** A repository path from a module URL under `root`, or a public URL string unchanged. */
function repositoryPath(root, value) {
  return value instanceof URL ? posix.relative(root.split('\\').join('/'), fileURLToPath(value).split('\\').join('/')) : value;
}

/** Refuse a browser module graph that cannot load, naming the module and the import. */
function refuseModule(path, text, why) {
  throw new Refused('RELAY_BROWSER_MODULE', `relay browser module ${path} imports ${text}: ${why}; serve a pure module or add a browser stand-in in apps/relay/src/io/deploy/browser-page.js`);
}

/**
 * Build every served browser module from repository bytes. Each import specifier is rewritten to the relative URL of
 * what the browser is served for its target: the repository file it names when one exists (served at its public name if
 * it has one), else a public name written as a virtual alias, a stand-in, a cell's pure core.js for its front door, or the
 * module itself at its repository path below MODULE_PREFIX. A Node builtin, a bare package or a missing file refuses.
 */
export function browserModules(root, { named, standins = {}, generated = {} }) {
  const served = new Map(), urlOf = new Map(), pending = [];
  // The kernel's light and index doors carry Node-only pieces (the process census imports node:crypto), so every browser graph reads the browser-safe door.
  const stand = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(KERNEL_BROWSER_DOORS).filter(([, door]) => fileSystem.exists(join(root, door)))), ...standins }).map(([path, value]) => [path, repositoryPath(root, value)]));
  for (const [url, value] of Object.entries(named)) { urlOf.set(repositoryPath(root, value), url); pending.push([url, repositoryPath(root, value)]); }
  const publicUrls = new Set([...Object.keys(named), ...Object.keys(generated)]);
  /** The URL a repository path is served at, queuing its module the first time. */
  const serve = path => {
    const door = /^packages\/[^/]+\/index\.js$/u.test(path) && fileSystem.exists(join(root, path.replace(/index\.js$/u, 'light.js'))) ? path.replace(/index\.js$/u, 'light.js') : path;
    const target = stand[path] ?? door;
    if (target.startsWith('/')) return target;
    if (!urlOf.has(target)) { urlOf.set(target, MODULE_PREFIX + target); pending.push([MODULE_PREFIX + target, target]); }
    return urlOf.get(target);
  };
  /** Rewrite each import specifier of one module; `path` is its repository path, or null for generated text. */
  const rewrite = (url, path, source) => {
    const info = lex(source);
    let out = source;
    for (const row of info.strings.filter(literal => /\b(?:from|import)\s*\(?\s*$/u.test(info.code.slice(0, literal.start))).reverse()) {
      const text = row.text, where = path ?? url;
      if (!text.startsWith('./') && !text.startsWith('../')) refuseModule(where, text, 'a browser cannot load a Node builtin or a bare package');
      // The real repository file wins: a public name is only a virtual alias for a specifier with no file behind it.
      const repository = path === null ? null : posix.normalize(posix.join(posix.dirname(path), text));
      const real = repository !== null && (Object.hasOwn(stand, repository) || fileSystem.exists(join(root, repository)));
      const asServed = posix.normalize(posix.join(posix.dirname(url), text));
      if (!real && !publicUrls.has(asServed)) refuseModule(where, text, 'it is neither a repository file nor a public relay module');
      const target = real ? serve(repository) : asServed;
      const relative = posix.relative(posix.dirname(url), target);
      out = out.slice(0, row.start + 1) + (relative.startsWith('.') ? relative : `./${relative}`) + out.slice(row.end - 1);
    }
    return out;
  };
  while (pending.length) {
    const [url, path] = pending.shift();
    if (served.has(url)) continue;
    if (!fileSystem.exists(join(root, path))) refuseModule(path, path, 'the file does not exist');
    served.set(url, rewrite(url, path, fileSystem.readFile(join(root, path), 'utf8')));
  }
  for (const [url, source] of Object.entries(generated)) served.set(url, rewrite(url, null, source));
  return served;
}

/** Refuse relay startup locally while the public shell has no relay session; keep its sign-in link and never reload. */
const SIGN_IN_TRANSPORT = '/** Preserve device-only pairing before sign-in without starting relay reads. */\nimport { rememberPairing } from "./client.js";\nimport { registerApp } from "./install.js";\nexport function createTransport() {\n  void registerApp();\n  rememberPairing();\n  throw new Error("Sign in with GitHub to open your linked boards.");\n}\n';

/**
 * Name the device before first paint: a phone or tablet (a coarse pointer and no hover) never runs Pullboard, so
 * it shows its signed-in or sign-in screen before any asynchronous probe. A computer keeps the page's own states.
 */
function deviceScript(relaySession) {
  return "(() => { const root = document.documentElement; if (!matchMedia('(pointer: coarse)').matches || !matchMedia('(hover: none)').matches) return;"
    + " root.dataset.relayDevice = 'phone'; root.dataset.relayScreen = '" + (relaySession ? 'share' : 'sign-in') + "'; })();";
}

/** Serve a fixed asset with cache and browser isolation boundaries, never a filesystem-derived URL. */
function respond(res, type, content, scriptHashes = []) {
  const hashes = scriptHashes.map(hash => "'sha256-" + hash + "'").join(' ');
  res.writeHead(200, {
    'content-type': type + (typeof content === 'string' ? '; charset=utf-8' : ''), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self' " + hashes + "; style-src 'self'; connect-src 'self' http://127.0.0.1:4890 http://localhost:4890; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(content);
}

/** Serve the board-free shell publicly; a session enables only its separate read-only relay transport. */
export function createRelayBrowserHandler({ authenticate }) {
  const modules = browserModules(ROOT, { named: BROWSER_MODULES, standins: BROWSER_STANDINS, generated: {
    '/relay/screens.js': '/** Wire the first screens\' Copy buttons [H17]. */\nimport { wireRelayScreens } from \'./browser-notice.js\';\nwireRelayScreens(document);\n',
    '/relay/sign-in.js': SIGN_IN_TRANSPORT,
    '/relay/engine.js': 'export const ENGINE_VERSION = ' + ENGINE_VERSION + ';\nexport const MACHINE = ' + JSON.stringify({ initial: MACHINE.initial, moves: MACHINE.moves.map(({ verb, from, to, by }) => ({ verb, from, to, by })) }) + ';\n',
  } });
  const assets = new Map([
    ['/view.css', ['text/css', STYLES]],
    ['/relay/screens.css', ['text/css', fileSystem.readFile(new URL('./screens.css', import.meta.url), 'utf8')]],
    ['/manifest.webmanifest', ['application/manifest+json', fileSystem.readFile(new URL('../app.webmanifest', import.meta.url), 'utf8')]],
    ['/service-worker.js', ['text/javascript', fileSystem.readFile(new URL('../../logic/worker.js', import.meta.url), 'utf8')]],
    ['/icons/pullboard.svg', ['image/svg+xml', fileSystem.readFile(new URL('../icons/pullboard.svg', import.meta.url), 'utf8')]],
    ['/icons/pullboard-192.png', ['image/png', fileSystem.readFile(new URL('../icons/pullboard-192.png', import.meta.url), null)]],
    ['/icons/pullboard-512.png', ['image/png', fileSystem.readFile(new URL('../icons/pullboard-512.png', import.meta.url), null)]],
    // A JSON module (an import with { type: 'json' }) must be answered as JSON, or Chrome refuses the whole graph that reaches it [H5,H15].
    ...[...modules].map(([path, source]) => [path, [path.endsWith('.json') ? 'application/json' : 'text/javascript', source]]),
  ]);
  return async function handleBrowser(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET') return false;
    if (assets.has(path)) {
      const [type, content] = assets.get(path);
      respond(res, type, content);
      return true;
    }
    if (path !== '/') return false;
    let relaySession = false;
    let removedSession = false;
    try {
      const who = await authenticate(req);
      if (who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'Sign in as a person to open the relay view.');
      relaySession = true;
    } catch (error) {
      if (!(error instanceof Refused) || !['AUTH_REQUIRED', 'HUMAN_REQUIRED', 'DEVICE_REVOKED'].includes(error.code)) throw error;
      removedSession = error.code === 'DEVICE_REVOKED';
    }
    // The public, board-free shell must still load so its client can erase a removed browser's local keys.
    const notice = removedSession ? '<p>Checking this browser…</p>' : relaySession ? '<p>Pairing this browser…</p>'
      : '<p>Connecting to this machine. Sign in to see your linked boards.</p><a href="/auth/github/start">Sign in with GitHub</a>';
    const page = cockpitPage('', { readOnly: true, requests: relaySession, transportModule: relaySession || removedSession ? '/relay/client.js' : '/relay/sign-in.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession: relaySession || removedSession, signIn: '/auth/github/start' })
      .replace('<link rel="icon" href="data:,">', '<link rel="icon" href="/icons/pullboard.svg" type="image/svg+xml">\n<link rel="manifest" href="/manifest.webmanifest">\n<link rel="apple-touch-icon" href="/icons/pullboard-192.png">\n<meta name="theme-color" content="#f6faf7">')
      .replace('</head>', '<link rel="stylesheet" href="/relay/screens.css">\n<script>' + deviceScript(relaySession) + '</script>\n</head>')
      .replace('<div class="shell">', relayScreenMarkup(relaySession ? 'share' : 'sign-in', '/auth/github/start') + '\n<div class="shell">')
      .replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status">' + notice + '</section>')
      .replace('</body>', '<script type="module" src="/relay/screens.js"></script>\n</body>');
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => createHash('sha256').update(match[1]).digest('base64'));
    respond(res, 'text/html', page, scripts);
    return true;
  };
}
