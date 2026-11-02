/** The relay keeps answering every browser URL it served before it moved into apps/relay [H5,H18]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../index.js';
import { Refused } from '../../../packages/kernel/index.js';

/** Every public relay URL main served before the move (captured at f96a52dac); /relay/m/ graph URLs are checked by closure below. */
const SERVED = [
  '/icons/pullboard-192.png',
  '/icons/pullboard-512.png',
  '/icons/pullboard.svg',
  '/manifest.webmanifest',
  '/relay/browser-approval-card.js',
  '/relay/browser-deadline.js',
  '/relay/browser-devices.js',
  '/relay/browser-excluded.js',
  '/relay/browser-history.js',
  '/relay/browser-notice.js',
  '/relay/browser-pages.js',
  '/relay/browser-passkeys.js',
  '/relay/browser-stream.js',
  '/relay/browser-upload-status.js',
  '/relay/client.js',
  '/relay/device-keys.js',
  '/relay/engine.js',
  '/relay/excluded-notice.js',
  '/relay/install.js',
  '/relay/lifecycle-move.js',
  '/relay/model.js',
  '/relay/page-layout.js',
  '/relay/person-bar-effect.js',
  '/relay/person-enrollment.js',
  '/relay/person-pairing-limit.js',
  '/relay/person-request.js',
  '/relay/refused.js',
  '/relay/relay-approval.js',
  '/relay/relay-limits.js',
  '/relay/screens.css',
  '/relay/screens.js',
  '/relay/seal.js',
  '/relay/sealed-pages.js',
  '/relay/sign-in.js',
  '/service-worker.js',
  '/view.css',
];

/** Answer one GET through the real browser handler and return its status, type and body. */
async function get(handler, path) {
  const res = { status: 0, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; } };
  const handled = await handler({ method: 'GET', url: path, headers: {} }, res);
  return { handled, ...res };
}

test('every relay browser URL served before the move still answers [H5,H18]', async () => {
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Refused('AUTH_REQUIRED', 'sign in'); } });
  for (const path of [...SERVED, '/']) {
    const reply = await get(handler, path);
    assert.equal(reply.handled, true, path);
    assert.equal(reply.status, 200, path);
    assert.ok(reply.body && reply.body.length > 0, path);
  }
});

test('every module a served relay script imports is itself served [H5,H18]', async () => {
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Refused('AUTH_REQUIRED', 'sign in'); } });
  const pending = SERVED.filter(path => path.endsWith('.js')), seen = new Set();
  while (pending.length) {
    const path = pending.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const reply = await get(handler, path);
    assert.equal(reply.status, 200, path);
    for (const [, specifier] of String(reply.body).matchAll(/^(?:import\b|export\b|\})[^'"\n]*['"](\.{1,2}\/[^'"]+)['"];?\s*$/gmu)) {
      pending.push(new URL(specifier, 'http://relay' + path).pathname);
    }
  }
  assert.ok(seen.size >= SERVED.filter(path => path.endsWith('.js')).length);
});
