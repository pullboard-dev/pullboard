/** The relay serves the existing cockpit over a device-only decrypting transport [H5,H15]. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cockpitPage } from '../src/cockpit.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { Refused } from '../src/refused.js';
import { APPROVAL_CARD_STYLES } from './browser-approval-card.js';
import { relayScreenMarkup } from './browser-notice.js';

const STYLES = readFileSync(new URL('../src/view.css', import.meta.url), 'utf8') + APPROVAL_CARD_STYLES;

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
  const assets = new Map([
    ['/view.css', ['text/css', STYLES]],
    ['/relay/screens.css', ['text/css', readFileSync(new URL('./browser-screens.css', import.meta.url), 'utf8')]],
    ['/relay/screens.js', ['text/javascript', '/** Wire the first screens\' Copy buttons [H17]. */\nimport { wireRelayScreens } from \'./browser-notice.js\';\nwireRelayScreens(document);\n']],
    ['/manifest.webmanifest', ['application/manifest+json', readFileSync(new URL('./app.webmanifest', import.meta.url), 'utf8')]],
    ['/service-worker.js', ['text/javascript', readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')]],
    ['/icons/pullboard.svg', ['image/svg+xml', readFileSync(new URL('./icons/pullboard.svg', import.meta.url), 'utf8')]],
    ['/icons/pullboard-192.png', ['image/png', readFileSync(new URL('./icons/pullboard-192.png', import.meta.url))]],
    ['/icons/pullboard-512.png', ['image/png', readFileSync(new URL('./icons/pullboard-512.png', import.meta.url))]],
    ['/relay/install.js', ['text/javascript', readFileSync(new URL('./browser-install.js', import.meta.url), 'utf8')]],
    ['/relay/device-keys.js', ['text/javascript', readFileSync(new URL('../src/relay-device-keys.js', import.meta.url), 'utf8')]],
    ['/relay/relay-approval.js', ['text/javascript', readFileSync(new URL('../src/relay-approval.js', import.meta.url), 'utf8').replace("'./relay-device-keys.js'", "'./device-keys.js'")]],
    ['/relay/browser-devices.js', ['text/javascript', readFileSync(new URL('./browser-devices.js', import.meta.url), 'utf8')]],
    ['/relay/browser-excluded.js', ['text/javascript', readFileSync(new URL('./browser-excluded.js', import.meta.url), 'utf8')]],
    ['/relay/excluded-notice.js', ['text/javascript', readFileSync(new URL('./excluded-notice.js', import.meta.url), 'utf8')]],
    ['/relay/browser-approval-card.js', ['text/javascript', readFileSync(new URL('./browser-approval-card.js', import.meta.url), 'utf8')]],
    ['/relay/browser-passkeys.js', ['text/javascript', readFileSync(new URL('./browser-passkeys.js', import.meta.url), 'utf8')]],
    ['/relay/client.js', ['text/javascript', readFileSync(new URL('./browser-client.js', import.meta.url), 'utf8')]],
    ['/relay/relay-limits.js', ['text/javascript', readFileSync(new URL('../src/relay-limits.js', import.meta.url), 'utf8')]],
    ['/relay/sign-in.js', ['text/javascript', SIGN_IN_TRANSPORT]],
    ['/relay/browser-notice.js', ['text/javascript', readFileSync(new URL('./browser-notice.js', import.meta.url), 'utf8')]],
    ['/relay/browser-upload-status.js', ['text/javascript', readFileSync(new URL('./browser-upload-status.js', import.meta.url), 'utf8')]],
    ['/relay/browser-deadline.js', ['text/javascript', readFileSync(new URL('./browser-deadline.js', import.meta.url), 'utf8').replace("'../src/refused.js'", "'./refused.js'")]],
    ['/relay/browser-stream.js', ['text/javascript', readFileSync(new URL('./browser-stream.js', import.meta.url), 'utf8')]],
    ['/relay/browser-pages.js', ['text/javascript', readFileSync(new URL('./browser-pages.js', import.meta.url), 'utf8').replaceAll("'../src/relay-page-layout.js'", "'./page-layout.js'").replaceAll("'../src/sealed-pages.js'", "'./sealed-pages.js'").replaceAll("'../src/refused.js'", "'./refused.js'")]],
    ['/relay/browser-history.js', ['text/javascript', readFileSync(new URL('./browser-history.js', import.meta.url), 'utf8')]],
    ['/relay/page-layout.js', ['text/javascript', readFileSync(new URL('../src/relay-page-layout.js', import.meta.url), 'utf8')]],
    ['/relay/sealed-pages.js', ['text/javascript', readFileSync(new URL('../src/sealed-pages.js', import.meta.url), 'utf8').replace("'../packages/kernel/src/core/seal.js'", "'./seal.js'")]],
    ['/relay/model.js', ['text/javascript', readFileSync(new URL('./browser-model.js', import.meta.url), 'utf8').replace("'../src/refused.js'", "'./refused.js'")]],
    ['/relay/engine.js', ['text/javascript', 'export const ENGINE_VERSION = ' + ENGINE_VERSION + ';\n']],
    ['/relay/seal.js', ['text/javascript', readFileSync(new URL('../packages/kernel/src/core/seal.js', import.meta.url), 'utf8')]],
    ['/relay/api-moves.js', ['text/javascript', readFileSync(new URL('../src/api-moves.js', import.meta.url), 'utf8')]],
    ['/relay/person-bar-effect.js', ['text/javascript', readFileSync(new URL('../src/person-bar-effect.js', import.meta.url), 'utf8')]],
    ['/relay/person-request.js', ['text/javascript', readFileSync(new URL('../src/person-request.js', import.meta.url), 'utf8')]],
    ['/relay/refused.js', ['text/javascript', readFileSync(new URL('../packages/kernel/src/core/refused.js', import.meta.url), 'utf8')]],
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
