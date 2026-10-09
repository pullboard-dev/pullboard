/** The relay serves the existing cockpit over a device-only decrypting transport [H5,H15]. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cockpitPage } from '../src/cockpit.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { Refused } from '../src/refused.js';

const STYLES = readFileSync(new URL('../src/view.css', import.meta.url), 'utf8');
const SIGN_IN = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pullboard</title><link rel="stylesheet" href="/view.css"><body><main class="card-panel"><h1>Pullboard</h1><p>Sign in to see your linked boards.</p><a href="/auth/github/start">Sign in with GitHub</a></main><script type="module">import { rememberPairing } from "/relay/client.js"; try { rememberPairing(); } catch { document.querySelector("main p").textContent = "The pairing link is invalid. Get a new link from a linked machine."; }</script></body></html>';

/** Serve a fixed asset with cache and browser isolation boundaries, never a filesystem-derived URL. */
function respond(res, type, content, scriptHashes = []) {
  const hashes = scriptHashes.map(hash => "'sha256-" + hash + "'").join(' ');
  res.writeHead(200, {
    'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self' " + hashes + "; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(content);
}

/** Serve generic assets publicly and board-free sign-in HTML until a person is authenticated. */
export function createRelayBrowserHandler({ authenticate }) {
  const assets = new Map([
    ['/view.css', ['text/css', STYLES]],
    ['/relay/device-keys.js', ['text/javascript', readFileSync(new URL('../src/relay-device-keys.js', import.meta.url), 'utf8')]],
    ['/relay/browser-devices.js', ['text/javascript', readFileSync(new URL('./browser-devices.js', import.meta.url), 'utf8')]],
    ['/relay/client.js', ['text/javascript', readFileSync(new URL('./browser-client.js', import.meta.url), 'utf8')]],
    ['/relay/browser-notice.js', ['text/javascript', readFileSync(new URL('./browser-notice.js', import.meta.url), 'utf8')]],
    ['/relay/browser-stream.js', ['text/javascript', readFileSync(new URL('./browser-stream.js', import.meta.url), 'utf8')]],
    ['/relay/model.js', ['text/javascript', readFileSync(new URL('./browser-model.js', import.meta.url), 'utf8').replace("'../src/refused.js'", "'./refused.js'")]],
    ['/relay/engine.js', ['text/javascript', 'export const ENGINE_VERSION = ' + ENGINE_VERSION + ';\n']],
    ['/relay/seal.js', ['text/javascript', readFileSync(new URL('../src/seal.js', import.meta.url), 'utf8')]],
    ['/relay/api-moves.js', ['text/javascript', readFileSync(new URL('../src/api-moves.js', import.meta.url), 'utf8')]],
    ['/relay/person-request.js', ['text/javascript', readFileSync(new URL('../src/person-request.js', import.meta.url), 'utf8')]],
    ['/relay/refused.js', ['text/javascript', readFileSync(new URL('../src/refused.js', import.meta.url), 'utf8')]],
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
    try {
      const who = await authenticate(req);
      if (who.kind !== 'session') throw new Refused('HUMAN_REQUIRED', 'Sign in as a person to open the relay view.');
    } catch (error) {
      if (!(error instanceof Refused) || !['AUTH_REQUIRED', 'HUMAN_REQUIRED'].includes(error.code)) throw error;
      const script = /<script type="module">([\s\S]*?)<\/script>/.exec(SIGN_IN)[1];
      respond(res, 'text/html', SIGN_IN, [createHash('sha256').update(script).digest('base64')]);
      return true;
    }
    const page = cockpitPage('', { readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css' })
      .replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Pairing this browser…</p></section>');
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => createHash('sha256').update(match[1]).digest('base64'));
    respond(res, 'text/html', page, scripts);
    return true;
  };
}
