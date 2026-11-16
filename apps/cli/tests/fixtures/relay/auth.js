/** Relay auth fixtures shared by the relay journey files [H8, H1]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createGitHubClient } from '../../../../relay/index.js';
import { createRelayAuth } from '../../../../relay/index.js';
import { githubFixture } from '../../../tests/fixtures/relay.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
export const CLI = resolve(import.meta.dirname, '../../../pullboard.js');

/** Build the run function joinFixtureSeat expects from a relay fixture box: the real CLI in the box's isolated environment. */
export function fixtureCli(box) {
  return (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: box.env, encoding: 'utf8' });
}

/** Open the relay confirmation page and retain only its browser cookie and one-use ticket. */
export async function openRelayConfirmation(box, confirmationURL) {
  const url = new URL(confirmationURL);
  const ticket = decodeURIComponent(url.hash.slice(1));
  assert.ok(ticket, 'confirmation nonce is carried in the browser fragment');
  const page = await fetch(new URL('/auth/device/confirm', url.origin));
  assert.equal(page.status, 200, 'relay serves the person confirmation page');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.match(html, /textContent="Link "|textContent = "Link "/u, 'the page inserts board and host labels as text');
  const wrongOrigin = await fetch(box.origin + '/auth/device/confirmation/open', {
    method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  assert.equal(wrongOrigin.status, 403, 'a foreign page cannot open the browser confirmation');
  const opened = await fetch(box.origin + '/auth/device/confirmation/open', {
    method: 'POST', headers: { origin: box.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
  });
  assert.equal(opened.status, 200, 'the confirmation page receives a cookie-bound browser session');
  const cookie = opened.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(cookie ?? '', /^pb_device_confirmation=/u);
  const cookieMaxAge = Number(/(?:^|;\s*)Max-Age=(\d+)/u.exec(opened.headers.get('set-cookie') ?? '')?.[1]);
  /** Read confirmation status with same-origin browser credentials and no URL capability. */
  async function status() {
    const response = await fetch(box.origin + '/auth/device/confirmation/status', {
      method: 'POST', headers: { origin: box.origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
    });
    return { response, document: await response.json() };
  }
  /** Submit one explicit person decision through the browser-cookie and exact-Origin boundary. */
  async function decide(decision, origin = box.origin) {
    return fetch(box.origin + '/auth/device/confirmation', {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ticket, decision }),
    });
  }
  return { ticket, cookie, cookieMaxAge, html, status, decide };
}

/** Count linked boards through a separate read-only SQLite connection. */
export function linkedBoardCount(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM relay_boards').get().count; }
  finally { db.close(); }
}

export const relaySetupURL = new URL('../../../../../packages/link/index.js', import.meta.url).href;
export const relayMachineURL = new URL('../../../../../packages/link/index.js', import.meta.url).href;
export const relayDeviceKeysURL = new URL('../../../../../packages/keys/index.js', import.meta.url).href;

/** Call the shared setup flow with a private caller signal and credential-free output streams. */
export async function runRelayOnAll(box, signalMode) {
  return box.scriptLocal(`
    import { relayOnAll } from ${JSON.stringify(relaySetupURL)};
    import { readRelayMachine } from ${JSON.stringify(relayMachineURL)};
    import { createDeviceKeys, signDeviceEnrollment } from ${JSON.stringify(relayDeviceKeysURL)}; import { nativeRelayPorts } from ${JSON.stringify(new URL('../native.js', import.meta.url).href)};
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    const mode = ${JSON.stringify(signalMode)};
    const pairingCallbacks = [];
    const messages = [];
    let enrollmentUploaded = false;
    if (['pairing-cancel', 'pairing-cancel-delete-fails', 'pairing-complete', 'pairing-abort-during-acceptance'].includes(mode)) {
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        const method = init?.method ?? input?.method ?? 'GET';
        if (mode === 'pairing-cancel-delete-fails' && url.pathname.startsWith('/api/v1/devices/enrollments/') && method === 'DELETE') {
          return new Response(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture cleanup was not acknowledged' } }),
            { status: 503, headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname.startsWith('/api/v1/devices/enrollments/') && method === 'GET' && controller.signal.aborted) {
          return new Response(JSON.stringify({ version: 1, error: { code: 'DEVICE_PAIR_EXPIRED', message: 'fixture stopped an ignored pairing cancellation' } }),
            { status: 410, headers: { 'content-type': 'application/json' } });
        }
        const response = await originalFetch(input, init);
        if (url.pathname.startsWith('/api/v1/devices/enrollments/') && method === 'GET') {
          if (mode.startsWith('pairing-cancel')) setImmediate(() => controller.abort());
          if (!mode.startsWith('pairing-cancel') && !enrollmentUploaded && !(await response.clone().json()).enrollment) {
            const callback = pairingCallbacks[0];
            const pairingUrl = callback?.url ?? messages.find(value => value.startsWith('Pair your phone once: '))?.slice('Pair your phone once: '.length);
            if (!pairingUrl) throw new Error('fixture could not find the in-memory pairing link');
            const fragment = new URL(pairingUrl).hash.slice('#device='.length);
            const [locator, secret] = fragment.split('.');
            const headers = new Headers(init?.headers ?? input?.headers);
            const authorization = headers.get('authorization');
            const engine = headers.get('x-pullboard-engine');
            const identityResponse = await originalFetch(new URL('/api/v1/devices/session', url.origin), {
              headers: { authorization, 'x-pullboard-engine': engine },
            });
            const { account } = await identityResponse.json();
            const keys = await createDeviceKeys();
            const enrollment = await signDeviceEnrollment(secret, {
              v: 1, account, locator, deviceId: keys.deviceId, publicKey: keys.publicKey,
              label: 'fixture phone', createdAt: new Date().toISOString(),
            });
            const enrolled = await originalFetch(url.href, {
              method: 'PUT', headers: { authorization, 'x-pullboard-engine': engine, 'content-type': 'application/json' },
              body: JSON.stringify(enrollment),
            });
            if (!enrolled.ok) throw new Error('fixture device enrollment was refused');
            enrollmentUploaded = true;
            if (mode === 'pairing-abort-during-acceptance') {
              const subtle = globalThis.crypto.subtle;
              const verify = subtle.verify.bind(subtle);
              subtle.verify = async (...args) => { controller.abort(); subtle.verify = verify; return verify(...args); };
            }
          }
        }
        return response;
      };
    } else if (mode === 'during-poll') {
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        if (url.pathname === '/auth/device/start') setImmediate(() => controller.abort());
        return response;
      };
    } else if (mode === 'during-flush') {
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        if (init?.method === 'DELETE' && url.pathname.startsWith('/api/v1/devices/')) {
          setImmediate(() => controller.abort());
          await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
        }
        return originalFetch(input, init);
      };
    } else if (['held-poll-response', 'held-poll-response-cancel-fails',
      'held-poll-response-denied', 'held-poll-response-expired'].includes(mode)) {
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        if (url.pathname === '/auth/device/cancel' && mode === 'held-poll-response-cancel-fails') {
          return new Response(JSON.stringify({ version: 1, error: { code: 'RELAY_ROUTE', message: 'fixture route is unavailable' } }),
            { status: 404, headers: { 'content-type': 'application/json' } });
        }
        const response = await originalFetch(input, init);
        if (url.pathname === '/auth/device/poll') {
          const body = await response.text();
          await new Promise(resolve => {
            controller.signal.addEventListener('abort', resolve, { once: true });
            setImmediate(() => controller.abort());
          });
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
      };
    } else if (mode === 'already-aborted') controller.abort();
    const output = { ...nativeRelayPorts(), personChannel: 'view', cwd: process.cwd(),
      stderr: { write() {} }, say(value) { messages.push(String(value)); }, err(value) { messages.push(String(value)); } };
    try {
      const result = await relayOnAll(${JSON.stringify(box.origin)}, output, {
        signal: controller.signal, onPairingURL(value) { pairingCallbacks.push(value); },
      });
      const machine = readRelayMachine();
      process.stdout.write(JSON.stringify({ ...result,
        pairingCallbackCount: pairingCallbacks.length,
        pairingCallbackHasCode: Boolean(pairingCallbacks[0]?.url.includes('#device=')),
        pairingCallbackExpires: Number.isSafeInteger(pairingCallbacks[0]?.expires),
        pairingUrlPrinted: messages.some(value => value.includes('#device=')),
        pairingCleanupWarningShown: messages.some(value => value.includes('may retain this request')),
        signalAborted: controller.signal.aborted,
        enrollmentUploaded, pendingCleared: machine.pending === null, deviceCount: machine.devices.length,
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ errorCode: error.code ?? 'UNEXPECTED_ERROR' }));
      process.exitCode = 1;
    }
  `);
}

/** Seed one prior cleanup obligation so cancellation can be observed after auth and during flush. */
export async function seedRevocation(box) {
  return box.script(`
    import { updateRelayMachine } from ${JSON.stringify(relayMachineURL)};
    updateRelayMachine(state => { state.revocations = [{ deviceId: 'device-00000000000000000000000000000000', account: '7', url: ${JSON.stringify(box.origin)} }]; });
    process.stdout.write(JSON.stringify({ seeded: true }));
  `);
}

/** Snapshot only private local metadata that cancellation must leave byte-for-byte unchanged. */
export function fileSnapshot(path) { return existsSync(path) ? readFileSync(path) : null; }

/** Count live person-session ids without reading bearer hashes or token plaintext. */
export function livePersonSessionIds(box) {
  const db = new DatabaseSync(box.authDatabase ?? box.database, { readOnly: true });
  try { return db.prepare("SELECT id FROM relay_credentials WHERE kind='session' AND revoked=0 AND expires>? ORDER BY id").all(Date.now()).map(row => row.id); }
  finally { db.close(); }
}

/** Revoke only test-created session rows after asserting a fail-closed cleanup refusal. */
export function revokeFixtureSessions(box, ids) {
  const db = new DatabaseSync(box.authDatabase ?? box.database);
  try { for (const id of ids) db.prepare("UPDATE relay_credentials SET revoked=1 WHERE kind='session' AND id=?").run(id); }
  finally { db.close(); }
}

/** Register a second synthetic local project without linking it to the private relay. */
export async function registerSecondProject(box) {
  const root = join(dirname(box.root), 'cancel-second-project');
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository-2.git']]) { // one team board per repository [E12]
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env, encoding: 'utf8', timeout: 15_000 }).status, 0);
  }
  assert.equal((await box.cliAt(root, 'init')).code, 0, 'the second fixture project is registered on this machine');
  const exported = await box.cliAt(root, 'export');
  const id = exported.document.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  return { linkFile: join(root, '.git', 'pullboard', 'relay.json'), keyFile: join(box.env.PULLBOARD_HOME, 'relay-keys', id + '.key') };
}

/** Use real private SQLite and an actual HTTP provider with a controllable expiry clock. */
export async function fixture(t, options = {}) {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-auth-'));
  const database = join(root, 'auth.sqlite');
  let time = Date.now();
  const clock = () => time;
  const github = createGitHubClient(provider.config);
  const config = { database, github, now: clock, ...options };
  const auth = createRelayAuth(config);
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...provider, providerConfig: provider.config, auth, database, config, now: () => time, advance(ms) { time += ms; } };
}

/** Complete a real stand-in device grant, advancing only the injected relay expiry clock. */
export async function login(box) {
  const grant = await box.auth.beginDevice();
  box.state.deviceAuthorized = true;
  box.advance(grant.interval * 1000);
  return box.auth.pollDevice(grant.ticket);
}

