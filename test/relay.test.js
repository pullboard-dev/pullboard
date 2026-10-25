/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ENGINE_VERSION } from '../src/machine.js';
import { createGitHubClient } from '../relay/github.js';
import { createRelayAuth, ACCESS_WINDOW_MS } from '../relay/auth.js';
import { serveRelay } from '../relay/service.js';
import { githubFixture } from './relay-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { serveView } from '../src/serve.js';
import { fetchFresh } from './http-fixture.js';
import { fetchPrintedViewLink } from './view-link-fixture.js';
import { VERIFIER_STANDING_ENGINE } from '../src/machine.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Open the relay confirmation page and retain only its browser cookie and one-use ticket. */
async function openRelayConfirmation(box, confirmationURL) {
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
function linkedBoardCount(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM relay_boards').get().count; }
  finally { db.close(); }
}

const relaySetupURL = new URL('../src/relay-setup.js', import.meta.url).href;
const relayMachineURL = new URL('../src/relay-machine.js', import.meta.url).href;
const relayDeviceKeysURL = new URL('../src/relay-device-keys.js', import.meta.url).href;

/** Call the shared setup flow with a private caller signal and credential-free output streams. */
async function runRelayOnAll(box, signalMode) {
  return box.script(`
    import { relayOnAll } from ${JSON.stringify(relaySetupURL)};
    import { readRelayMachine } from ${JSON.stringify(relayMachineURL)};
    import { createDeviceKeys, signDeviceEnrollment } from ${JSON.stringify(relayDeviceKeysURL)};
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
    const output = { personChannel: 'view', cwd: process.cwd(),
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
async function seedRevocation(box) {
  return box.script(`
    import { updateRelayMachine } from ${JSON.stringify(relayMachineURL)};
    updateRelayMachine(state => { state.revocations = [{ deviceId: 'device-00000000000000000000000000000000', account: '7', url: ${JSON.stringify(box.origin)} }]; });
    process.stdout.write(JSON.stringify({ seeded: true }));
  `);
}

/** Snapshot only private local metadata that cancellation must leave byte-for-byte unchanged. */
function fileSnapshot(path) { return existsSync(path) ? readFileSync(path) : null; }

/** Count live person-session ids without reading bearer hashes or token plaintext. */
function livePersonSessionIds(box) {
  const db = new DatabaseSync(box.authDatabase ?? box.database, { readOnly: true });
  try { return db.prepare("SELECT id FROM relay_credentials WHERE kind='session' AND revoked=0 AND expires>? ORDER BY id").all(Date.now()).map(row => row.id); }
  finally { db.close(); }
}

/** Revoke only test-created session rows after asserting a fail-closed cleanup refusal. */
function revokeFixtureSessions(box, ids) {
  const db = new DatabaseSync(box.authDatabase ?? box.database);
  try { for (const id of ids) db.prepare("UPDATE relay_credentials SET revoked=1 WHERE kind='session' AND id=?").run(id); }
  finally { db.close(); }
}

/** Register a second synthetic local project without linking it to the private relay. */
async function registerSecondProject(box) {
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
async function fixture(t, options = {}) {
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
async function login(box) {
  const grant = await box.auth.beginDevice();
  box.state.deviceAuthorized = true;
  box.advance(grant.interval * 1000);
  return box.auth.pollDevice(grant.ticket);
}

test('a minted device session stays cancellable after its device grant expires [H5,N26]', async (t) => {
  const box = await fixture(t);
  const prior = await login(box);
  const grantStarted = box.now();
  box.state.deviceAuthorized = true;
  const grant = await box.auth.beginDevice();
  box.advance(grant.interval * 1000);
  const minted = await box.auth.pollDevice(grant.ticket);
  assert.equal(box.now(), grantStarted + grant.interval * 1000, 'the grant uses the injected auth clock');
  const beforeExpiry = livePersonSessionIds({ authDatabase: box.database });
  assert.equal(beforeExpiry.includes(prior.id), true, 'the preexisting session remains live');
  assert.equal(beforeExpiry.includes(minted.id), true, 'the device grant minted one new live session');

  box.advance((grant.expiresIn - grant.interval) * 1000);
  assert.equal(box.now(), grantStarted + grant.expiresIn * 1000, 'the clock reaches the exact grant deadline');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' }, 'polling remains strictly expired at the grant deadline');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'the bounded cleanup receipt revokes the session after its grant expires');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'a known cleanup remains idempotent');
  await assert.rejects(box.auth.authenticate(minted.token), { code: 'AUTH_REQUIRED' }, 'only the newly minted session is revoked');
  assert.equal((await box.auth.authenticate(prior.token)).id, prior.id, 'cleanup preserves the preexisting session');
  assert.deepEqual(livePersonSessionIds({ authDatabase: box.database }), [prior.id], 'the expired grant receipt cannot revoke another live session');
  assert.deepEqual(await box.auth.cancelDevice('pd_' + 'x'.repeat(43)), { cancelled: false }, 'an unknown ticket is never treated as cleaned up');
});

test('device-session cleanup survives grant pruning but ends at session expiry [H5,N26]', async (t) => {
  const box = await fixture(t, { sessionTTL: 30 * 60_000 });
  const prior = await login(box);
  const grantStarted = box.now();
  box.state.deviceAuthorized = true;
  const grant = await box.auth.beginDevice();
  box.advance(grant.interval * 1000);
  const minted = await box.auth.pollDevice(grant.ticket);
  box.advance((grant.expiresIn - grant.interval) * 1000);

  const nextGrant = await box.auth.beginDevice(); // pruneFlows removes the expired flow first
  assert.equal(box.now(), grantStarted + grant.expiresIn * 1000, 'the session cleanup receipt outlives only the original grant');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' }, 'pruning never makes an expired ticket pollable');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'flow pruning preserves the exact live session cleanup receipt');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: true }, 'the pruned ticket receipt remains idempotent');
  await assert.rejects(box.auth.authenticate(minted.token), { code: 'AUTH_REQUIRED' }, 'the receipt revoked its own session');
  assert.equal((await box.auth.authenticate(prior.token)).id, prior.id, 'pruned-flow cleanup preserves the prior session');
  assert.deepEqual(await box.auth.cancelDevice(nextGrant.ticket), { cancelled: true }, 'the replacement grant remains independently cancellable');

  box.advance(minted.expires - box.now());
  assert.equal(box.now(), minted.expires, 'the cleanup receipt reaches the exact session expiry');
  assert.deepEqual(await box.auth.cancelDevice(grant.ticket), { cancelled: false }, 'expired cleanup receipts are no longer accepted as cancellation proof');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' }, 'an expired cleanup receipt never restores poll access');
});

test('linking every board stops cleanly when the sign-in is declined or cancelled [H5,N26]', async (t) => {
  for (const scenario of ['already-cancelled', 'declined', 'expired', 'cancelled-during-sign-in', 'cancelled-after-sign-in']) await t.test(scenario, async (t) => {
    const box = await relayClientFixture(t);
    const second = await registerSecondProject(box);
    box.refuseBoardLinks(true);
    box.providerState.deviceAuthorized = scenario !== 'cancelled-during-sign-in';
    box.providerState.deviceDeclined = scenario === 'declined';
    box.providerState.deviceExpired = scenario === 'expired';
    if (scenario === 'cancelled-after-sign-in') {
      box.overrideDelete({ status: 200 });
      assert.equal((await seedRevocation(box)).code, 0, 'a prior revocation is queued before setup begins');
    }
    const priorSession = scenario === 'cancelled-after-sign-in' ? await box.phoneSession() : null;
    const sessionsBefore = livePersonSessionIds(box);
    const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine', 'state.json');
    const before = new Map([box.linkFile, second.linkFile, box.keyFile, second.keyFile, machineFile].map(path => [path, fileSnapshot(path)]));
    if (scenario === 'cancelled-during-sign-in') {
      // A broken caller that ignores abort sees a provider denial at its first poll instead of hanging.
      setTimeout(() => { box.providerState.deviceDeclined = true; }, 100);
    }
    const mode = scenario === 'already-cancelled' ? 'already-aborted'
      : scenario === 'cancelled-during-sign-in' ? 'during-poll'
      : scenario === 'cancelled-after-sign-in' ? 'during-flush' : 'none';
    const result = await runRelayOnAll(box, mode);
    assert.equal(result.code, 0, 'the private setup caller returns a structured terminal outcome');
    const expected = scenario === 'declined' ? 'declined' : scenario === 'expired' ? 'expired' : 'cancelled';
    assert.equal(result.document.outcome, expected, 'sign-in termination has a named outcome');
    assert.deepEqual(result.document.linked ?? [], [], 'no board is linked after an interrupted sign-in');
    assert.deepEqual(result.document.failed ?? [], [], 'cancellation is not reported as a per-board failure');
    assert.deepEqual(fileSnapshot(box.linkFile), before.get(box.linkFile), 'cancelled sign-in leaves the board link file unchanged');
    assert.deepEqual(fileSnapshot(second.linkFile), before.get(second.linkFile), 'cancellation leaves the second registered board unlinked');
    assert.deepEqual(fileSnapshot(box.keyFile), before.get(box.keyFile), 'cancelled sign-in leaves the board key unchanged');
    assert.deepEqual(fileSnapshot(second.keyFile), before.get(second.keyFile), 'cancellation leaves the second board key unstored');
    assert.deepEqual(livePersonSessionIds(box), sessionsBefore, 'a pre-link terminal outcome leaves no new live person session');
    if (priorSession) assert.equal((await box.auth.authenticate(priorSession.token)).id, priorSession.id, 'cancellation preserves the preexisting person session');
    if (scenario === 'cancelled-after-sign-in') {
      const prior = JSON.parse(before.get(machineFile).toString('utf8'));
      const after = JSON.parse(fileSnapshot(machineFile).toString('utf8'));
      assert.equal(after.autoLink, prior.autoLink, 'cancellation before the first link does not enable auto-linking');
      assert.deepEqual(after.owner, prior.owner, 'cancellation before the first link does not change the saved owner');
      assert.deepEqual(after.approvals, prior.approvals, 'cancellation before the first link preserves pending approvals');
      assert.deepEqual(after.revocations, [], 'the already-queued revocation is flushed as its existing cleanup obligation');
    } else {
      assert.deepEqual(fileSnapshot(machineFile), before.get(machineFile), 'decline or cancellation during sign-in does not mutate machine metadata');
    }
    assert.equal(box.transit.some(record => /\/auth\/boards\/link$|\/auth\/machines$|^\/api\/v1\/boards\//u.test(record.path)), false,
      'no board or machine credential request begins before sign-in is committed');
    if (scenario === 'already-cancelled') {
      assert.equal(box.transit.some(record => record.path === '/auth/device/start'), false,
        'an already-aborted signal prevents the device flow from starting');
      assert.equal(box.providerCalls.some(call => call.path === '/login/oauth/access_token'), false,
        'an already-aborted signal makes no provider request');
    }
    if (scenario === 'cancelled-during-sign-in') {
      assert.equal(box.transit.some(record => record.path === '/auth/device/start'), true, 'the caller cancels an active device sign-in');
    }
    if (scenario === 'declined' || scenario === 'expired') {
      assert.equal(box.providerCalls.some(call => call.path === '/login/oauth/access_token'), true, 'the real synthetic provider returns the terminal sign-in result');
    }
  });

  await t.test('cancellation revokes a session minted behind a held poll response', async (t) => {
    const box = await relayClientFixture(t);
    const second = await registerSecondProject(box);
    box.refuseBoardLinks(true);
    const priorSession = await box.phoneSession();
    const sessionsBefore = livePersonSessionIds(box);
    const before = [box.linkFile, second.linkFile, box.keyFile, second.keyFile].map(path => [path, fileSnapshot(path)]);
    const result = await runRelayOnAll(box, 'held-poll-response');
    assert.equal(result.code, 0, 'the held response is canceled through the ticket cleanup path');
    assert.equal(result.document.outcome, 'cancelled', 'the caller reports cancellation only after cleanup confirmation');
    assert.deepEqual(livePersonSessionIds(box), sessionsBefore, 'the just-minted session is revoked');
    assert.equal((await box.auth.authenticate(priorSession.token)).id, priorSession.id, 'cleanup does not revoke a preexisting session');
    assert.equal(box.transit.filter(record => record.method === 'POST' && record.path === '/auth/device/cancel').length, 1,
      'the held device flow is canceled through its ticket');
    for (const [path, contents] of before) assert.deepEqual(fileSnapshot(path), contents, 'a canceled poll leaves board links and keys unchanged');
  });

  for (const terminal of ['denied', 'expired']) await t.test(`cancellation acknowledges a held ${terminal} poll response without changing sessions`, async (t) => {
    const box = await relayClientFixture(t);
    const second = await registerSecondProject(box);
    box.refuseBoardLinks(true);
    box.providerState.deviceDeclined = terminal === 'denied';
    box.providerState.deviceExpired = terminal === 'expired';
    const priorSession = await box.phoneSession();
    const providerCallsBeforeAttempt = box.providerCalls.length;
    const sessionsBefore = livePersonSessionIds(box);
    const before = [box.linkFile, second.linkFile, box.keyFile, second.keyFile].map(path => [path, fileSnapshot(path)]);
    const result = await runRelayOnAll(box, `held-poll-response-${terminal}`);
    assert.equal(result.code, 0, 'a known terminal provider result is cleanable while its response is held');
    assert.equal(result.document.outcome, 'cancelled', 'cancellation is confirmed for this known terminal flow');
    assert.deepEqual(livePersonSessionIds(box), sessionsBefore, 'terminal provider results mint no person session');
    assert.equal((await box.auth.authenticate(priorSession.token)).id, priorSession.id, 'terminal cleanup preserves the prior session');
    assert.equal(box.transit.filter(record => record.method === 'POST' && record.path === '/auth/device/cancel').length, 1,
      'the terminal flow is acknowledged through its exact ticket');
    assert.equal(box.providerCalls.slice(providerCallsBeforeAttempt).some(call => call.path === '/user'), false,
      'a terminal provider response never reaches identity lookup');
    assert.equal(box.transit.some(record => record.path === '/auth/boards/link' || record.path === '/auth/machines'), false,
      'terminal cancellation never begins a board or machine write');
    for (const [path, contents] of before) assert.deepEqual(fileSnapshot(path), contents, 'terminal cancellation leaves board links and keys unchanged');
  });

  await t.test('cancellation during provider polling does not mint a person session', async (t) => {
    const box = await fixture(t);
    let markStarted;
    let release;
    const started = new Promise(resolve => { markStarted = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    box.state.deviceAuthorized = true;
    box.state.beforeDevicePoll = async () => { box.state.beforeDevicePoll = null; markStarted(); await held; };
    const grant = await box.auth.beginDevice();
    box.advance(grant.interval * 1000);
    const before = livePersonSessionIds({ authDatabase: box.database });
    const poll = box.auth.pollDevice(grant.ticket);
    await started;
    const cancellation = box.auth.cancelDevice(grant.ticket);
    release();
    await assert.rejects(poll, { code: 'OAUTH_CANCELLED' }, 'the provider result is discarded after cancellation');
    assert.deepEqual(await cancellation, { cancelled: true }, 'ticket cancellation waits for the provider operation to settle');
    assert.deepEqual(livePersonSessionIds({ authDatabase: box.database }), before, 'the canceled provider result creates no session');
  });

  await t.test('cancellation during GitHub identity lookup does not mint a person session', async (t) => {
    const box = await fixture(t);
    let markStarted;
    let release;
    const started = new Promise(resolve => { markStarted = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    box.state.deviceAuthorized = true;
    box.state.beforeUser = async () => { box.state.beforeUser = null; markStarted(); await held; };
    const grant = await box.auth.beginDevice();
    box.advance(grant.interval * 1000);
    const before = livePersonSessionIds({ authDatabase: box.database });
    const poll = box.auth.pollDevice(grant.ticket);
    await started;
    const cancellation = box.auth.cancelDevice(grant.ticket);
    release();
    await assert.rejects(poll, { code: 'OAUTH_CANCELLED' }, 'the identity result is discarded after cancellation');
    assert.deepEqual(await cancellation, { cancelled: true }, 'cancellation waits for identity lookup to settle');
    assert.deepEqual(livePersonSessionIds({ authDatabase: box.database }), before, 'the canceled identity result creates no session');
  });

  await t.test('a failed cancellation acknowledgement is not reported as success', async (t) => {
    const box = await relayClientFixture(t);
    box.refuseBoardLinks(true);
    const sessionsBefore = livePersonSessionIds(box);
    const result = await runRelayOnAll(box, 'held-poll-response-cancel-fails');
    assert.notEqual(result.code, 0, 'a failed cleanup acknowledgement fails the caller closed');
    assert.equal(result.document.errorCode, 'OAUTH_CLEANUP', 'cleanup failure is surfaced as a typed refusal');
    assert.equal(box.transit.some(record => record.method === 'POST' && record.path === '/auth/device/cancel'), false,
      'the unavailable cancel endpoint receives no request at the fixture');
    const after = livePersonSessionIds(box);
    const leaked = after.filter(id => !sessionsBefore.includes(id));
    assert.equal(leaked.length, 1, 'the test confirms cleanup was not falsely reported when the endpoint was unavailable');
    assert.equal(box.transit.some(record => record.path === '/auth/boards/link' || record.path === '/auth/machines'), false,
      'failed cancellation never begins a board or machine write');
    revokeFixtureSessions(box, leaked);
  });
});

test('a cancel during pairing keeps the links and stops pairing cleanly [H5,N26]', async (t) => {
  await t.test('cancellation before the first link remains a no-link outcome', async (t) => {
    const box = await relayClientFixture(t);
    await registerSecondProject(box);
    const result = await runRelayOnAll(box, 'already-aborted');
    assert.equal(result.code, 0);
    assert.equal(result.document.outcome, 'cancelled');
    assert.deepEqual(result.document.linked ?? [], []);
    assert.equal(box.transit.some(record => record.path === '/auth/boards/link'), false, 'no board-link request starts');
    assert.equal(result.document.pairingCallbackCount, 0, 'no pairing URL is announced');
  });

  for (const mode of ['pairing-cancel', 'pairing-cancel-delete-fails']) await t.test(mode, async (t) => {
    const box = await relayClientFixture(t);
    await registerSecondProject(box);
    const result = await runRelayOnAll(box, mode);
    assert.equal(result.code, 0, 'pairing cancellation is a named successful setup outcome');
    assert.equal(result.document.pairingOutcome, 'cancelled');
    assert.equal(result.document.paired, false);
    assert.equal(result.document.linked.length, 2, 'the completed board links remain in the result');
    assert.deepEqual(result.document.failed, []);
    assert.equal(result.document.pendingCleared, true, 'the local pending enrollment is removed');
    assert.equal(result.document.deviceCount, 0, 'cancellation before acceptance records no device');
    assert.equal(result.document.pairingCallbackCount, 1, 'the optional pairing callback receives the pairing address');
    assert.equal(result.document.pairingCallbackHasCode, true);
    assert.equal(result.document.pairingCallbackExpires, true);
    assert.equal(result.document.pairingUrlPrinted, false, 'the callback replaces CLI URL/QR output');
    assert.equal(result.document.signalAborted, true);
    if (mode === 'pairing-cancel') {
      assert.equal(result.document.pairingCleanup, 'confirmed');
      assert.equal(box.transit.filter(record => record.method === 'DELETE' && /\/api\/v1\/devices\/enrollments\//u.test(record.path)).length, 1);
    } else {
      assert.equal(result.document.pairingCleanup, 'unconfirmed', 'a refused DELETE is not reported as cleanup success');
      assert.equal(result.document.pairingCleanupWarningShown, true);
    }
  });

  for (const mode of ['pairing-complete', 'pairing-abort-during-acceptance']) await t.test(mode, async (t) => {
    const box = await relayClientFixture(t);
    await registerSecondProject(box);
    const result = await runRelayOnAll(box, mode);
    assert.equal(result.code, 0, 'the real loopback enrollment completes');
    assert.equal(result.document.pairingCallbackCount, 1, 'the optional pairing callback receives the pairing address');
    assert.equal(result.document.pairingUrlPrinted, false, 'the callback replaces CLI URL/QR output');
    assert.equal(result.document.pairingOutcome, 'paired');
    assert.equal(result.document.paired, true);
    assert.equal(result.document.linked.length, 2);
    assert.deepEqual(result.document.failed, []);
    assert.equal(result.document.pairingCallbackHasCode, true);
    assert.equal(result.document.enrollmentUploaded, true);
    assert.equal(result.document.pendingCleared, true);
    assert.equal(result.document.deviceCount, 1);
    assert.equal(box.transit.filter(record => record.method === 'PUT' && /\/api\/v1\/devices\/device-[0-9a-f]{32}\/boards\//u.test(record.path)).length, 2,
      'the enrolled device receives wraps for every linked board');
    assert.equal(result.document.signalAborted, mode === 'pairing-abort-during-acceptance');
  });
});

test('browser state/cookie binding and one-use device ticket protect both sign-in flows [H8, H1]', async (t) => {
  const box = await fixture(t);
  const web = box.auth.beginWeb();
  const authorized = await fetch(web.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location'));
  const state = callback.searchParams.get('state');
  const code = callback.searchParams.get('code');
  await assert.rejects(box.auth.finishWeb(state, code, 'wrong-browser'), { code: 'OAUTH_STATE' });
  const signed = await box.auth.finishWeb(state, code, web.binding);
  assert.equal((await box.auth.authenticate(signed.token)).user.id, '7');
  await assert.rejects(box.auth.finishWeb(state, code, web.binding), { code: 'OAUTH_STATE' });
  const grant = await box.auth.beginDevice();
  assert.equal(grant.deviceCode, undefined);
  const polls = box.calls.filter(call => call.path === '/login/oauth/access_token').length;
  assert.equal((await box.auth.pollDevice(grant.ticket)).pending, true);
  assert.equal(box.calls.filter(call => call.path === '/login/oauth/access_token').length, polls);
  box.advance(1000);
  box.state.slow = true;
  assert.equal((await box.auth.pollDevice(grant.ticket)).retryAfter, 6);
  box.advance(6000);
  box.state.deviceAuthorized = true;
  const cli = await box.auth.pollDevice(grant.ticket);
  assert.equal((await box.auth.authenticate(cli.token)).user.id, '7');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' });
});

test('relay on from an SSH shell links only after the person confirms in the browser [P6, H5, H8, B26]', async (t) => {
  const box = await relayClientFixture(t);
  const ssh = { SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22', PULLBOARD_RELAY_TOKEN: 'pa_' + 'x'.repeat(43) };
  const running = box.startCli(['relay', 'on', '--url', box.origin], ssh);
  const marker = 'After sign-in, confirm the link in your browser: ';
  const output = await running.waitForOutput(marker);
  const startResponse = await box.waitForResponse('/auth/device/start');
  const deviceGrant = JSON.parse(startResponse.response.toString());
  const line = output.split('\n').find(value => value.includes(marker));
  const confirmationURL = line?.slice(line.indexOf(marker) + marker.length).trim();
  assert.ok(confirmationURL, 'SSH sign-in prints the separate browser confirmation address');
  await box.waitForResponse('/auth/device/poll');
  const browser = await openRelayConfirmation(box, confirmationURL);
  assert.ok(browser.cookieMaxAge > 600 && browser.cookieMaxAge <= deviceGrant.expiresIn + 600,
    'an early browser visit remains bound through the remaining device grant and ten-minute confirmation window');
  const status = await browser.status();
  assert.equal(status.response.status, 200);
  assert.equal(status.document.ready, true, 'the relay holds the GitHub session until the device grant is complete');
  assert.equal(status.document.intent.boardName, basename(box.root));
  assert.equal(status.document.intent.host, hostname());
  assert.equal(JSON.stringify(status.document).includes('token'), false, 'the browser status does not expose a relay credential');
  assert.equal(linkedBoardCount(box.authDatabase), 0, 'no board is linked before the person confirms');
  const foreignDecision = await browser.decide('confirm', 'https://foreign.invalid');
  assert.equal(foreignDecision.status, 403, 'a foreign origin cannot confirm even with the browser cookie');
  assert.equal(linkedBoardCount(box.authDatabase), 0, 'a refused cross-origin decision creates no link');
  const confirmed = await browser.decide('confirm');
  assert.equal(confirmed.status, 200, 'the exact-origin browser action confirms the displayed intent');
  assert.equal(linkedBoardCount(box.authDatabase), 1, 'the relay links only after affirmative confirmation');
  const completed = await running.closed;
  assert.equal(completed.signal, null);
  assert.equal(completed.code, 0, 'SSH relay on receives the person session only after confirmation');
  assert.equal(JSON.parse(completed.stdout).linked, true);

  const declineBox = await relayClientFixture(t);
  const declinedRun = declineBox.startCli(['relay', 'on', '--url', declineBox.origin], { SSH_TTY: '/dev/pts/8' });
  const declinedOutput = await declinedRun.waitForOutput(marker);
  const declinedLine = declinedOutput.split('\n').find(value => value.includes(marker));
  const declinedURL = declinedLine?.slice(declinedLine.indexOf(marker) + marker.length).trim();
  assert.ok(declinedURL);
  await declineBox.waitForResponse('/auth/device/poll');
  const declinedBrowser = await openRelayConfirmation(declineBox, declinedURL);
  assert.equal((await declinedBrowser.status()).document.ready, true);
  assert.equal((await declinedBrowser.decide('decline')).status, 200);
  const declined = await declinedRun.closed;
  assert.equal(declined.code, 1, 'the CLI reports a person decline');
  assert.equal(JSON.parse(declined.stdout).error.code, 'OAUTH_DENIED');
  assert.equal(linkedBoardCount(declineBox.authDatabase), 0, 'declining leaves the board unlinked');

  const startsBeforeRefusals = box.calls.filter(call => call.path === '/auth/device/start').length;
  const agent = spawnSync(process.execPath, [CLI, 'relay', 'on', '--url', box.origin, '--json'], {
    cwd: box.root, env: { ...box.env, SSH_CONNECTION: ssh.SSH_CONNECTION, AI_AGENT: '1' }, encoding: 'utf8',
  });
  assert.equal(agent.status, 1);
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent-marked SSH shell still cannot link');
  const personAnswer = spawnSync(process.execPath, [CLI, 'answer', '1', 'yes', '--as', 'person', '--json'], {
    cwd: box.root, env: { ...box.env, SSH_CONNECTION: ssh.SSH_CONNECTION }, encoding: 'utf8',
  });
  assert.equal(personAnswer.status, 1);
  assert.equal(JSON.parse(personAnswer.stdout).error.code, 'B26_PERSON_CHANNEL', 'other person-only SSH actions remain refused');
  assert.equal(box.calls.filter(call => call.path === '/auth/device/start').length, startsBeforeRefusals,
    'refused shell actions never start another browser grant');
});

test('an unanswered device board confirmation expires after ten minutes [H8]', async (t) => {
  const box = await fixture(t);
  const intent = { board: 'ssh-board', boardName: 'fixture-board', host: 'fixture-host', repository: 'fixture/repository' };
  const flow = await box.auth.beginDevice({ intent });
  box.state.deviceAuthorized = true;
  box.advance(flow.interval * 1000);
  const pending = await box.auth.pollDevice(flow.ticket);
  assert.equal(pending.pendingConfirmation, true);
  assert.equal('token' in pending, false, 'the CLI ticket does not return the held person session');
  const browser = box.auth.openDeviceConfirmation(flow.confirmationTicket);
  const status = box.auth.deviceConfirmationStatus(flow.confirmationTicket, browser.binding);
  assert.equal(status.ready, true);
  assert.equal('token' in status, false, 'browser status contains no relay credential');
  box.advance(10 * 60_000);
  await assert.rejects(box.auth.pollDevice(flow.ticket), { code: 'OAUTH_EXPIRED' });
  assert.equal(linkedBoardCount(box.database), 0, 'an unanswered intent never links a board');
  const db = new DatabaseSync(box.database);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relay_credentials WHERE kind='session' AND revoked=1").get().count, 1,
      'the server-held session is revoked after the confirmation deadline');
  } finally { db.close(); }
});

test('a confirmation approved before its deadline can reach the SSH CLI just after ten minutes [P6, H5]', async (t) => {
  const box = await fixture(t);
  const intent = { board: 'ssh-board', boardName: 'fixture-board', host: 'fixture-host', repository: 'fixture/repository' };
  const flow = await box.auth.beginDevice({ intent });
  const browser = box.auth.openDeviceConfirmation(flow.confirmationTicket);
  box.state.deviceAuthorized = true;
  box.advance(flow.interval * 1000);
  const pending = await box.auth.pollDevice(flow.ticket);
  assert.equal(pending.pendingConfirmation, true);
  box.advance(599_000);
  const approved = await box.auth.confirmDevice(flow.confirmationTicket, browser.binding, 'confirm');
  assert.equal(approved.confirmed, true, 'the person approved before the original confirmation deadline');
  box.advance(2_000);
  const delivered = await box.auth.pollDevice(flow.ticket);
  assert.equal(delivered.linkConfirmed, true, 'the valid approval remains retrievable after its decision deadline');
  assert.equal(delivered.linkedBoard, intent.board);
  assert.match(delivered.token, /^ps_[A-Za-z0-9_-]{43}$/u);
});

test('device authorization stays serialized while GitHub confirms its user [P6, H5]', async (t) => {
  const box = await fixture(t);
  const intent = { board: 'ssh-board', boardName: 'fixture-board', host: 'fixture-host', repository: 'fixture/repository' };
  const flow = await box.auth.beginDevice({ intent });
  const originalUser = box.config.github.user;
  let releaseLookup;
  let announceLookup;
  const lookupStarted = new Promise((resolve) => { announceLookup = resolve; });
  const lookupHeld = new Promise((resolve) => { releaseLookup = resolve; });
  let lookupCount = 0;
  box.config.github.user = async (token) => {
    lookupCount += 1;
    if (lookupCount === 1) {
      announceLookup();
      await lookupHeld;
    }
    return originalUser(token);
  };
  box.state.deviceAuthorized = true;
  box.advance(flow.interval * 1000);
  let firstPoll;
  try {
    firstPoll = box.auth.pollDevice(flow.ticket);
    await lookupStarted;
    const providerPolls = () => box.calls.filter((call) => call.path === '/login/oauth/access_token').length;
    assert.equal(providerPolls(), 1, 'the first provider poll produced the grant now being resolved');
    box.advance(flow.interval * 1000);
    const concurrent = await box.auth.pollDevice(flow.ticket);
    assert.equal(concurrent.pending, true, 'a second CLI request waits while identity confirmation finishes');
    assert.equal(concurrent.pendingConfirmation, undefined, 'the held session is not exposed as ready yet');
    assert.equal(providerPolls(), 1, 'the concurrent CLI request cannot consume the provider grant again');

    releaseLookup();
    const pending = await firstPoll;
    assert.equal(pending.pendingConfirmation, true);
    assert.equal('token' in pending, false, 'the held session remains unavailable before person approval');
    const browser = box.auth.openDeviceConfirmation(flow.confirmationTicket);
    const status = box.auth.deviceConfirmationStatus(flow.confirmationTicket, browser.binding);
    assert.equal(status.ready, true, 'the original browser confirmation remains attached to the authorized device flow');
    assert.equal('token' in status, false, 'browser status never returns the held session credential');
    const waiting = await box.auth.pollDevice(flow.ticket);
    assert.equal(waiting.pendingConfirmation, true, 'the CLI keeps waiting for the person decision');
    assert.equal('token' in waiting, false);
    assert.equal(lookupCount, 1, 'one successful device grant creates one server-held user session');
  } finally {
    releaseLookup();
    if (firstPoll) await firstPoll.catch(() => {});
  }
});

test('unreadable links are refused; agent tokens belong to exactly one board [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  box.state.access = false;
  await assert.rejects(box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  box.state.access = true;
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  await box.auth.linkBoard(signed.token, 'beta', 'fixture/repository-2'); // one team board per repository [E12]
  const agent = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker-1' });
  assert.equal((await box.auth.authenticate(agent.token, { board: 'alpha', write: true })).agent, 'worker-1');
  const before = box.calls.length;
  await assert.rejects(box.auth.authenticate(agent.token, { board: 'beta', write: true }), { code: 'TOKEN_BOARD' });
  assert.equal(box.calls.length, before, 'cross-board credentials are rejected before a provider check');
  assert.deepEqual((await box.auth.boardsFor(agent.token)).map(board => board.id), ['alpha']);
  await assert.rejects(box.auth.linkBoard(agent.token, 'gamma', 'fixture/repository'), { code: 'HUMAN_REQUIRED' });
});

test('lost GitHub read access takes effect at ten minutes and before every board write [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  await box.auth.authenticate(signed.token, { board: 'alpha' });
  box.state.access = false;
  box.advance(ACCESS_WINDOW_MS - 1);
  assert.equal((await box.auth.boardsFor(signed.token)).length, 1, 'cached reads last less than ten minutes');
  box.advance(1);
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  box.state.access = true;
  await box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  box.state.access = false;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' });
  assert.deepEqual(await box.auth.boardsFor(signed.token), [], 'a denied write invalidates an earlier allowed read');
});

test('person token management lists only owned scoped metadata and preserves independent revocation [H2,H9]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  await box.auth.linkBoard(person.token, 'alpha', 'fixture/repository');
  await box.auth.linkBoard(person.token, 'beta', 'fixture/repository-2'); // one team board per repository [E12]
  const first = await box.auth.issueToken(person.token, { board: 'alpha', agent: 'worker-one' });
  const second = await box.auth.issueToken(person.token, { board: 'alpha', agent: 'worker-two' });
  const other = await box.auth.issueToken(person.token, { board: 'beta', agent: 'worker-one' });
  const foreign = new DatabaseSync(box.database);
  try {
    foreign.prepare('INSERT INTO relay_users(id,login) VALUES (?,?)').run('8', 'other-person');
    foreign.prepare('INSERT INTO relay_credentials(id,hash,kind,user_id,board,agent,expires) VALUES (?,?,?,?,?,?,?)')
      .run('foreign-private-fixture', 'f'.repeat(64), 'board', '8', 'alpha', 'foreign-worker', Date.now() + 60_000);
  } finally { foreign.close(); }
  const listed = await box.auth.listTokens(person.token, 'alpha');
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((row) => row.agent), ['worker-one', 'worker-two']);
  for (const row of listed) {
    assert.deepEqual(Object.keys(row).sort(), ['agent', 'board', 'created', 'expires', 'id', 'revoked']);
    assert.equal(row.board, 'alpha');
    assert.equal(row.revoked, false);
  }
  for (const secret of [person.token, first.token, second.token, other.token]) {
    assert.equal(JSON.stringify(listed).includes(secret), false, 'listing never includes a credential value');
  }
  await assert.rejects(box.auth.listTokens(first.token, 'alpha'), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(box.auth.listTokens(first.token, 'beta'), { code: 'TOKEN_BOARD' });
  await box.auth.revoke(person.token, first.id);
  assert.equal((await box.auth.listTokens(person.token, 'alpha')).find((row) => row.id === first.id).revoked, true);
  await assert.rejects(box.auth.authenticate(first.token, { board: 'alpha', write: true }), { code: 'AUTH_REQUIRED' });
  assert.equal((await box.auth.authenticate(second.token, { board: 'alpha', write: true })).agent, 'worker-two');
  assert.equal((await box.auth.authenticate(other.token, { board: 'beta', write: true })).agent, 'worker-one');
  box.state.permission = 'read';
  await assert.rejects(box.auth.listTokens(person.token, 'alpha'), { code: 'WRITE_REQUIRED' });
});

test('credentials are hash-only, expire, revoke individually and survive relay restart [H8, H1]', async (t) => {
  const box = await fixture(t, { sessionTTL: 30_000 });
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const first = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'one', expiresIn: 10_000 });
  const second = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'two', expiresIn: 20_000 });
  assert.notEqual(first.token, second.token);
  await box.auth.revoke(signed.token, first.id);
  await assert.rejects(box.auth.authenticate(first.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  assert.equal((await box.auth.authenticate(second.token, { board: 'alpha' })).agent, 'two');
  const persisted = readFileSync(box.database);
  for (const secret of [signed.token, first.token, second.token, box.providerConfig.privateKey, box.providerConfig.clientSecret, ...box.userTokens, ...box.installationTokens].filter(Boolean)) {
    assert.ok(!persisted.includes(Buffer.from(secret)), 'plaintext credential is absent from real SQLite bytes');
  }
  box.auth.close();
  const userCalls = box.calls.filter(call => call.path === '/user').length;
  const restarted = createRelayAuth({ ...box.config, github: createGitHubClient(box.providerConfig) });
  t.after(() => restarted.close());
  assert.equal((await restarted.authenticate(signed.token, { board: 'alpha', write: true })).user.id, '7');
  assert.equal(box.calls.filter(call => call.path === '/user').length, userCalls, 'restart requires no new sign-in or user credential');
  await assert.rejects(restarted.authenticate(first.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  box.advance(20_000);
  await assert.rejects(restarted.authenticate(second.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  box.advance(10_000);
  await assert.rejects(restarted.authenticate(signed.token), { code: 'AUTH_REQUIRED' });
});

test('revoking during an awaited GitHub write check refuses the pending write [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  box.state.beforePermission = async () => { entered(); await held; };
  const pending = box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  await started;
  await box.auth.revoke(signed.token, signed.id);
  release();
  await assert.rejects(pending, { code: 'AUTH_REQUIRED' });
});

test('revoking a board credential while its upload body is open stores nothing [H8, A4, H7]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  const board = 'b'.repeat(32);
  await box.auth.linkBoard(person.token, board, 'fixture/repository');
  const agent = await box.auth.issueToken(person.token, { board, agent: 'revoked-during-upload' });
  const service = await serveRelay({
    directory: join(dirname(box.database), 'journal'), auth: box.auth, port: 0,
    publicOrigin: 'http://127.0.0.1:44444', maintenanceMs: 0,
  });
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const snapshot = await fetch(`${origin}/api/v1/boards/${board}/state`, {
    method: 'PUT',
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 0, sealed: 'AQ' }),
  });
  assert.equal(snapshot.status, 200);

  let firstAuthenticationComplete;
  let signaled = false;
  const authenticated = new Promise((resolve) => { firstAuthenticationComplete = resolve; });
  const authenticate = box.auth.authenticate;
  box.auth.authenticate = async (...args) => {
    const result = await authenticate(...args);
    if (!signaled && args[1]?.board === board) {
      signaled = true;
      firstAuthenticationComplete();
    }
    return result;
  };
  let stream;
  const upload = fetch(`${origin}/api/v1/boards/${board}/moves`, {
    method: 'POST',
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { stream = controller; controller.enqueue(Buffer.from('{"sequence":1,"sealed":"')); } }),
    duplex: 'half',
  });
  await authenticated;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await box.auth.revoke(person.token, agent.id);
  stream.enqueue(Buffer.from('AQ"}'));
  stream.close();

  const response = await upload;
  const refusal = await response.json();
  assert.equal(response.status, 401, JSON.stringify(refusal));
  assert.equal(refusal.error.code, 'AUTH_REQUIRED');
  const events = await fetch(`${origin}/api/v1/boards/${board}/events?after=0`, {
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}` },
  });
  assert.equal(events.status, 200);
  assert.deepEqual((await events.json()).events, [], 'the revoked upload never appends a move');
  assert.equal(existsSync(join(dirname(box.database), 'journal', `${board}.journal.sqlite`)), true);
});

test('revoking a person token during snapshot upload preserves the prior snapshot [H8, A4, H7]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  const observer = await login(box);
  const board = 'c'.repeat(32);
  await box.auth.linkBoard(person.token, board, 'fixture/repository');
  const service = await serveRelay({
    directory: join(dirname(box.database), 'journal'), auth: box.auth, port: 0,
    publicOrigin: 'http://127.0.0.1:44444', maintenanceMs: 0,
  });
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const firstSnapshot = await fetch(`${origin}/api/v1/boards/${board}/state`, {
    method: 'PUT',
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 0, sealed: 'AQ' }),
  });
  assert.equal(firstSnapshot.status, 200);

  let firstAuthenticationComplete;
  let signaled = false;
  const authenticated = new Promise((resolve) => { firstAuthenticationComplete = resolve; });
  const authenticate = box.auth.authenticate;
  box.auth.authenticate = async (...args) => {
    const result = await authenticate(...args);
    if (!signaled && args[1]?.board === board) {
      signaled = true;
      firstAuthenticationComplete();
    }
    return result;
  };
  let stream;
  const upload = fetch(`${origin}/api/v1/boards/${board}/state`, {
    method: 'PUT',
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { stream = controller; controller.enqueue(Buffer.from('{"sequence":0,"sealed":"')); } }),
    duplex: 'half',
  });
  await authenticated;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await box.auth.revoke(person.token, person.id);
  stream.enqueue(Buffer.from('Ag"}'));
  stream.close();

  const response = await upload;
  const refusal = await response.json();
  assert.equal(response.status, 401, JSON.stringify(refusal));
  assert.equal(refusal.error.code, 'AUTH_REQUIRED');
  const current = await fetch(`${origin}/api/v1/boards/${board}/state`, {
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${observer.token}` },
  });
  assert.equal(current.status, 200);
  const saved = await current.json();
  assert.equal(saved.state.sequence, 0);
  assert.equal(saved.state.sealed, 'AQ', 'the snapshot uploaded before revocation remains the latest snapshot');
});

test('a deleted and recreated repository cannot inherit the linked board [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  box.state.repositoryID = 200;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' });
  await assert.rejects(box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository'), { code: 'BOARD_LINK_CONFLICT' });
});

test('expired browser/device grants cannot create sessions and concurrent polls consume only once [H8, H1]', async (t) => {
  const box = await fixture(t);
  const web = box.auth.beginWeb();
  const response = await fetch(web.authorizationURL, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location'));
  box.advance(10 * 60_000);
  await assert.rejects(box.auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), web.binding), { code: 'OAUTH_STATE' });
  const expired = await box.auth.beginDevice();
  box.advance(expired.expiresIn * 1000);
  await assert.rejects(box.auth.pollDevice(expired.ticket), { code: 'OAUTH_EXPIRED' });
  const grant = await box.auth.beginDevice();
  box.state.deviceAuthorized = true;
  box.advance(grant.interval * 1000);
  const results = await Promise.all([box.auth.pollDevice(grant.ticket), box.auth.pollDevice(grant.ticket)]);
  assert.equal(results.filter(result => result.token).length, 1);
  assert.equal(results.filter(result => result.pending).length, 1);
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' });
});

test('a public reader sees no board and cannot act, mint or revoke; refusal matches a missing board [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
  box.state.permission = 'none';
  let missing;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'absent', write: true }), error => {
    missing = { code: error.code, message: error.message }; return error.code === 'BOARD_NOT_LINKED';
  });
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), error => {
    assert.deepEqual({ code: error.code, message: error.message }, missing); return true;
  });
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'second' }), { code: 'BOARD_NOT_LINKED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'BOARD_NOT_LINKED' });
  box.state.permission = 'write';
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha', write: true })).agent, 'worker', 'denied revocation did not alter the token');
});

test('a public triage account sees its board but cannot act, mint or revoke its tokens [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
  box.state.permission = 'triage';
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'WRITE_REQUIRED' });
  assert.deepEqual((await box.auth.boardsFor(signed.token)).map(board => board.id), ['alpha']);
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha' })).permission, 'triage');
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'second' }), { code: 'WRITE_REQUIRED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'WRITE_REQUIRED' });
});

test('write, maintain and admin accounts act and mint while private readers only see [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  let existing;
  for (const permission of ['write', 'maintain', 'admin']) {
    box.state.permission = permission;
    assert.equal((await box.auth.authenticate(signed.token, { board: 'alpha', write: true })).permission, permission);
    // Each seat gets one first mint (#579), so each permission mints its own seat.
    existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker-' + permission });
    assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha', write: true })).permission, permission);
    await box.auth.revoke(signed.token, existing.id);
    await assert.rejects(box.auth.authenticate(existing.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  }
  box.state.permission = 'write';
  existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'reader' });
  box.state.permission = 'read';
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'WRITE_REQUIRED' });
  assert.equal((await box.auth.boardsFor(signed.token)).length, 1);
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha' })).permission, 'read');
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'no' }), { code: 'WRITE_REQUIRED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'WRITE_REQUIRED' });
});

test('an explicit read role still hides a public board below triage [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  box.state.permission = 'read';
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'BOARD_NOT_LINKED' });
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' }), { code: 'BOARD_NOT_LINKED' });
});

test('relay off forgets expired and remotely deleted boards while preserving local rows [H1,H7,H18]', async (t) => {
  for (const cause of ['expired', 'other-client']) await t.test(cause, async (t) => {
    const box = await relayClientFixture(t);
    await box.link();
    const localBeforeOff = (await box.cli('export')).document.tables;
    const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    if (cause === 'expired') box.advance(90);
    else {
      const phone = await box.phoneSession();
      const deleted = await fetchFresh(`${box.origin}/api/v1/boards/${link.board}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${phone.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
      });
      assert.equal(deleted.status, 200, 'an explicit person HTTP DELETE removes the remote board');
    }
    const callsBeforeOff = box.calls.length;
    const off = await box.cli('relay', 'off');
    assert.equal(off.code, 0);
    assert.equal(off.document.linked, false);
    assert.match(off.document.notice, /Local link removed/u);
    assert.equal(existsSync(box.linkFile), false, 'local link metadata is forgotten');
    assert.equal(existsSync(box.keyFile), false, 'device-only fallback key is forgotten');
    assert.deepEqual((await box.cli('export')).document.tables, localBeforeOff, 'local rows and event history survive remote deletion or expiry');
    assert.ok(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).excluded.includes(box.root),
      'the local opt-out remains durable after unlink');
    assert.equal(box.calls.slice(callsBeforeOff).some(call => call.method === 'DELETE'), false,
      'relay off never deletes the relay copy without its separate phone approval');
    const count = box.calls.length;
    assert.equal((await box.cli('relay', 'off')).code, 0);
    assert.equal((await box.cli('status')).code, 0);
    assert.equal(box.calls.length, count, 'repeated off and local commands make no relay connection');
  });
});

test('relay off completes local unlink when the relay is offline [H1,H7,H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const localBeforeOff = (await box.cli('export')).document.tables;
  await box.stopRelay();
  const callsBeforeOff = box.calls.length;
  const off = await box.cli('relay', 'off');
  assert.equal(off.code, 0, 'local unlink succeeds without a reachable relay');
  assert.match(off.document.notice, /relay copy stays until you approve deleting it on your phone/u);
  assert.equal(existsSync(box.linkFile), false);
  assert.equal(existsSync(box.keyFile), false);
  assert.ok(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).excluded.includes(box.root),
    'the local opt-out remains durable');
  assert.deepEqual((await box.cli('export')).document.tables, localBeforeOff, 'offline unlink preserves all local rows');
  assert.equal(box.calls.length, callsBeforeOff, 'offline local unlink makes no relay request');
  assert.equal(box.calls.some(call => call.method === 'DELETE'), false, 'offline local unlink cannot delete the remote copy');
});

test('BOARD_INACTIVE appears once per command and resets for a second command in the same process [H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  box.advance(80);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    const counts = [];
    for (let i = 0; i < 2; i++) {
      let output = '';
      const code = await main(['status', '--json'], {
        cwd: process.cwd(), stdout: { write(part) { output += part; } },
        stderr: { write() {} },
      });
      const value = JSON.parse(output);
      counts.push({ code, warnings: (value.diagnostics || []).filter(line => line.includes('BOARD_INACTIVE')).length });
    }
    console.log(JSON.stringify(counts));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, [{ code: 0, warnings: 1 }, { code: 0, warnings: 1 }]);
});

test('unlinked board commands attempt zero outbound requests [H1,P5]', async (t) => {
  const box = await relayClientFixture(t);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    const attempts = [];
    const blocked = kind => { attempts.push(kind); throw new Error('unexpected outbound attempt: ' + kind); };
    globalThis.fetch = async () => blocked('fetch');
    http.request = (...args) => blocked('http.request');
    https.request = (...args) => blocked('https.request');
    net.connect = (...args) => blocked('net.connect');
    net.Socket.prototype.connect = function (...args) { return blocked('net.Socket.connect'); };
    tls.connect = (...args) => blocked('tls.connect');
    const codes = [];
    for (const args of [
      ['status'], ['list'], ['show', '1'], ['add', ${JSON.stringify(box.lane)}, 'another fixture item'],
      ['shout', ${JSON.stringify(box.lane)}, 'fixture local message'], ['relay'], ['relay', 'off'],
    ]) {
      try {
        codes.push(await main([...args, '--json'], {
          cwd: process.cwd(), stdout: { write() {} }, stderr: { write() {} },
        }));
      } catch { codes.push(-1); }
    }
    console.log(JSON.stringify({ attempts, codes }));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document.attempts, [], 'fetch, HTTP(S), raw net and TLS connections are all watched');
  assert.ok(result.document.codes.every(code => code === 0), 'all ordinary local board commands succeed without transport');
});


test('offline linked reads use the local board, moves refuse, and the same relay resumes [H10]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const beforeBytes = readFileSync(boardFile);
  const beforeTables = (await box.cli('export')).document.tables;
  const beforeEvents = beforeTables.event;
  const oldEnvironment = new Map(['HOME', 'PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME']
    .map(name => [name, process.env[name]]));
  for (const name of oldEnvironment.keys()) process.env[name] = box.env[name];
  let view;
  try {
    view = await serveView({ port: 0 });
    const page = await fetchPrintedViewLink(view.url);
    assert.equal(page.status, 200, 'the real local view page remains available');
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);

    await box.stopRelay();
    const status = await box.cli('status');
    const listed = await box.cli('list', '--all');
    const shown = await box.cli('show', '1');
    assert.equal(status.code, 0, 'status reads its local board while disconnected');
    assert.equal(listed.code, 0, 'list reads its local board while disconnected');
    assert.ok(listed.document.items.some(item => item.item_title === 'private cleanup fixture item'));
    assert.equal(shown.code, 0, 'show reads its local board while disconnected');
    assert.equal(shown.document.item_title, 'private cleanup fixture item');

    const viewKey = new URL(view.url).searchParams.get('k');
    const localBoardsUrl = new URL('/api/v1/boards', view.url);
    localBoardsUrl.searchParams.set('k', viewKey);
    const localBoardsResponse = await fetchFresh(localBoardsUrl);
    assert.equal(localBoardsResponse.status, 200, 'the local view API remains available offline');
    const localBoards = await localBoardsResponse.json();
    const localBoard = localBoards.boards.find(board => board.root === box.root);
    assert.ok(localBoard, 'the local view still lists the linked project from its local registry');
    const localStateUrl = new URL(`/api/v1/boards/${localBoard.id}/state`, view.url);
    localStateUrl.searchParams.set('k', viewKey);
    const localStateResponse = await fetchFresh(localStateUrl);
    assert.equal(localStateResponse.status, 200);
    const localState = await localStateResponse.json();
    assert.ok(localState.state.items.some(item => item.title === 'private cleanup fixture item'),
      'the local view reads the same private board contents while the relay is stopped');

    for (const args of [
      ['add', box.lane, 'refused offline add'],
      ['shout', 'coordinator', 'refused offline shout'],
    ]) {
      const refused = await box.cli(...args);
      assert.equal(refused.code, 1);
      assert.equal(refused.document.error.code, 'RELAY_UNAVAILABLE');
      assert.ok(refused.document.error.message.includes(box.origin), 'the refusal names the address attempted');
      assert.match(refused.document.error.message, /retry this move when the relay is reachable/);
    }
    const viewMoveUrl = new URL(`/api/v1/boards/${localBoard.id}/moves`, view.url);
    viewMoveUrl.searchParams.set('k', viewKey);
    const viewMove = await fetchFresh(viewMoveUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'add', args: { lane: box.lane, title: 'refused offline view move' } }),
    });
    assert.equal(viewMove.status, 409, 'the local view API uses the linked move refusal path');
    assert.equal((await viewMove.json()).error.code, 'RELAY_UNAVAILABLE');

    assert.deepEqual(readFileSync(boardFile), beforeBytes, 'offline reads and refused moves leave the native board bytes unchanged');
    assert.deepEqual((await box.cli('export')).document.tables, beforeTables, 'no speculative local move or event was applied');

    await box.restartRelay();
    const resumed = await box.cli('add', box.lane, 'move after relay returns');
    assert.equal(resumed.code, 0, 'the relay resumes without relay off/on repair');
    assert.equal(resumed.document.item.item_title, 'move after relay returns');
    const afterTables = (await box.cli('export')).document.tables;
    assert.equal(afterTables.event.length, beforeEvents.length + 1, 'only the acknowledged recovery move is recorded locally');
    assert.equal(afterTables.event.at(-1).event_kind, 'add');
    const remoteStateResponse = await fetch(`${box.origin}/api/v2/boards/${link.board}/state`, {
      headers: { authorization: `Bearer ${link.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
    });
    assert.equal(remoteStateResponse.status, 200);
    assert.equal((await remoteStateResponse.json()).state.sequence, 1, 'the resumed move has exactly one relay position');
  } finally {
    if (view) await view.close();
    for (const [name, value] of oldEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a linked device without its key reads locally and refuses moves with both repairs [H10,H17]', async (t) => {
  const box = await relayClientFixture(t);
  // The isolated PATH must install the real CLI for Git's generated hooks in the new worktree.
  symlinkSync(resolve(import.meta.dirname, '../bin/pullboard.js'), join(box.env.PATH, 'pullboard'));
  const staged = spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const seeded = spawnSync('git', ['commit', '-m', 'chore(test): seed fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const agentRoot = join(box.root, '..', 'missing-key-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-missing-key-agent', agentRoot, 'HEAD'], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktree.status, 0, worktree.stderr);
  const prepare = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run a real CLI command from the fixture worktree and capture its JSON result. */
    async function command(cwd, args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const joined = await command(${JSON.stringify(agentRoot)}, ['join', ${JSON.stringify(box.lane)}, '--route', 'mid']);
    const asked = await command(${JSON.stringify(agentRoot)}, ['shout', 'coordinator', 'Should this fixture continue?', '--decision']);
    process.stdout.write(JSON.stringify({ joined, asked }));
  `);
  assert.equal(prepare.document.joined.code, 0, 'the real agent worktree joins its lane');
  assert.equal(prepare.document.asked.code, 0, 'the agent creates a real open decision before its key is removed');
  const decision = prepare.document.asked.document.id;
  assert.ok(Number.isSafeInteger(decision));
  await box.link();
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const beforeBytes = readFileSync(boardFile);
  const callsBefore = box.calls.length;
  assert.equal(existsSync(box.keyFile), true);
  rmSync(box.keyFile);
  assert.equal(existsSync(box.keyFile), false, 'the isolated device key is actually absent');

  const reads = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one local read and capture its JSON document and diagnostics. */
    async function command(args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd: process.cwd(), stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const status = await command(['status']);
    const list = await command(['list', '--all']);
    const show = await command(['show', '1']);
    const decisions = await command(['decisions']);
    process.stdout.write(JSON.stringify({ status, list, show, decisions }));
  `);
  const localReads = Object.values(reads.document);
  for (const result of localReads) {
    assert.equal(result.code, 0, JSON.stringify(result.document));
    assert.equal(result.document.diagnostics?.length, 1, 'each read gets one missing-key line despite sync before and after the command');
    assert.match(result.document.diagnostics[0], /RELAY_KEY_MISSING|board key is missing/);
    assert.match(result.document.diagnostics[0], /moves are off until the key is reachable/);
    assert.match(result.document.diagnostics[0], /run this command where the key is available, or pair this device/);
  }
  assert.ok(reads.document.list.document.items.some(item => item.item_title === 'private cleanup fixture item'), 'list returns the local item');
  assert.equal(reads.document.show.document.item_title, 'private cleanup fixture item', 'show returns the local item');
  assert.ok(reads.document.decisions.document.decisions.some(ask => ask.shout_id === decision), 'decisions returns the locally stored open question');
  assert.equal(box.calls.length, callsBefore, 'missing key is detected before any relay request');

  const moves = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one linked move and capture its refusal document. */
    async function command(cwd, args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const claim = await command(${JSON.stringify(agentRoot)}, ['claim', '1']);
    const shout = await command(${JSON.stringify(agentRoot)}, ['shout', 'coordinator', 'must not be sent']);
    const answer = await command(${JSON.stringify(box.root)}, ['answer', ${JSON.stringify(String(decision))}, 'yes']);
    process.stdout.write(JSON.stringify({ claim, shout, answer }));
  `);
  for (const result of Object.values(moves.document)) {
    assert.equal(result.code, 1);
    assert.equal(result.document.error.code, 'RELAY_KEY_MISSING');
    assert.match(result.document.error.message, /board key is missing/);
    assert.match(result.document.error.message, /run this command where the key is available, or pair this device/);
  }
  assert.deepEqual(readFileSync(boardFile), beforeBytes, 'reads and refused moves leave the local board unchanged');
  assert.equal(box.calls.length, callsBefore, 'no read or refused move reaches the relay');
});

test('a linked device with an unreadable key reads locally and refuses moves with both repairs [H10,H17]', async (t) => {
  const box = await relayClientFixture(t);
  // The isolated PATH must install the real CLI for Git's generated hooks in the new worktree.
  symlinkSync(resolve(import.meta.dirname, '../bin/pullboard.js'), join(box.env.PATH, 'pullboard'));
  const staged = spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const seeded = spawnSync('git', ['commit', '-m', 'chore(test): seed fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const agentRoot = join(box.root, '..', 'missing-key-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-missing-key-agent', agentRoot, 'HEAD'], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktree.status, 0, worktree.stderr);
  const prepare = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run a real CLI command from the fixture worktree and capture its JSON result. */
    async function command(cwd, args) {
      let output = '';
      const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
      return { code, document: JSON.parse(output) };
    }
    const joined = await command(${JSON.stringify(agentRoot)}, ['join', ${JSON.stringify(box.lane)}, '--route', 'mid']);
    const asked = await command(${JSON.stringify(agentRoot)}, ['shout', 'coordinator', 'Should this fixture continue?', '--decision']);
    process.stdout.write(JSON.stringify({ joined, asked }));
  `);
  assert.equal(prepare.document.joined.code, 0, 'the real agent worktree joins its lane');
  assert.equal(prepare.document.asked.code, 0, 'the agent creates a real open decision before its key is removed');
  const decision = prepare.document.asked.document.id;
  assert.ok(Number.isSafeInteger(decision));
  await box.link();
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const beforeBytes = readFileSync(boardFile);
  const callsBefore = box.calls.length;
  assert.equal(existsSync(box.keyFile), true);
  chmodSync(box.keyFile, 0o000);
  t.after(() => { if (existsSync(box.keyFile)) chmodSync(box.keyFile, 0o600); });
  assert.throws(() => readFileSync(box.keyFile), { code: 'EACCES' }, 'the real key file is denied to this shell');

  const reads = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one local read and capture its JSON document and diagnostics. */
    async function command(args) {
      let output = '';
      try {
        const code = await main([...args, '--json'], { cwd: process.cwd(), stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
        return { code, document: JSON.parse(output) };
      } catch (error) {
        return { code: error.code, document: { thrown: error.message } };
      }
    }
    const status = await command(['status']);
    const list = await command(['list', '--all']);
    const show = await command(['show', '1']);
    const decisions = await command(['decisions']);
    process.stdout.write(JSON.stringify({ status, list, show, decisions }));
  `);
  const localReads = Object.values(reads.document);
  for (const result of localReads) {
    assert.equal(result.code, 0, JSON.stringify(result.document));
    assert.equal(result.document.diagnostics?.length, 1, 'each read gets one unreadable-key line despite sync before and after the command');
    assert.match(result.document.diagnostics[0], /board key is unreadable in this shell \(EACCES\)/);
    assert.match(result.document.diagnostics[0], /moves are off until the key is reachable/);
    assert.match(result.document.diagnostics[0], /run this command where the key is available, or pair this device/);
  }
  assert.ok(reads.document.list.document.items.some(item => item.item_title === 'private cleanup fixture item'), 'list returns the local item');
  assert.equal(reads.document.show.document.item_title, 'private cleanup fixture item', 'show returns the local item');
  assert.ok(reads.document.decisions.document.decisions.some(ask => ask.shout_id === decision), 'decisions returns the locally stored open question');
  assert.equal(box.calls.length, callsBefore, 'unreadable key is detected before any relay request');

  const moves = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one linked move and capture its refusal document. */
    async function command(cwd, args) {
      let output = '';
      try {
        const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
        return { code, document: JSON.parse(output) };
      } catch (error) {
        return { code: error.code, document: { thrown: error.message } };
      }
    }
    const claim = await command(${JSON.stringify(agentRoot)}, ['claim', '1']);
    const shout = await command(${JSON.stringify(agentRoot)}, ['shout', 'coordinator', 'must not be sent']);
    const answer = await command(${JSON.stringify(box.root)}, ['answer', ${JSON.stringify(String(decision))}, 'yes']);
    process.stdout.write(JSON.stringify({ claim, shout, answer }));
  `);
  for (const result of Object.values(moves.document)) {
    assert.equal(result.code, 1);
    assert.equal(result.document.error.code, 'RELAY_KEY_MISSING');
    assert.match(result.document.error.message, /board key is unreadable in this shell \(EACCES\)/);
    assert.match(result.document.error.message, /run this command where the key is available, or pair this device/);
  }
  assert.deepEqual(readFileSync(boardFile), beforeBytes, 'reads and refused moves leave the local board unchanged');
  assert.equal(box.calls.length, callsBefore, 'no read or refused move reaches the relay');
});

test('plain relay off explains the retained relay copy without printing credentials [H1,H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const localBeforeOff = (await box.cli('export')).document.tables;
  const callsBeforeOff = box.calls.length;
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    let output = '';
    const code = await main(['relay', 'off'], {
      cwd: process.cwd(), stdout: { write(part) { output += part; } }, stderr: { write() {} },
    });
    console.log(JSON.stringify({ code,
      retained: output.includes('relay copy stays until you approve deleting it on your phone'),
      credential: /(?:ps|pm|pa|pg)_[A-Za-z0-9_-]{43}|key=/u.test(output) }));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, { code: 0, retained: true, credential: false });
  assert.equal(existsSync(box.linkFile), false, 'plain local off removes the device link');
  assert.equal(existsSync(box.keyFile), false, 'plain local off forgets the device key');
  assert.ok(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8')).excluded.includes(box.root));
  assert.deepEqual((await box.cli('export')).document.tables, localBeforeOff, 'plain local off preserves native rows');
  assert.equal(box.calls.slice(callsBeforeOff).some(call => call.method === 'DELETE'), false,
    'plain local off never deletes the remote copy without phone approval');
});


test('every real CLI relay request declares its engine including sign-in, reads, writes and unlink [H16,H3]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cli('export')).code, 0);
  assert.equal((await box.cli('add', box.lane, 'Declared-engine fixture move')).code, 0);
  const off = await box.cli('relay', 'off');
  assert.equal(off.code, 0);
  assert.match(off.document.notice, /relay copy stays until you approve deleting it on your phone/u);
  assert.ok(box.calls.some(call => call.path.startsWith('/auth/')));
  assert.ok(box.calls.some(call => call.method === 'GET' && call.path.includes('/events')));
  assert.ok(box.calls.some(call => call.method === 'POST' && call.path.endsWith('/moves')));
  assert.ok(box.calls.some(call => call.method === 'POST' && /^\/api\/v2\/boards\/[0-9a-f]{32}\/uploads\/[^/]+\/publish$/u.test(call.path)), 'the current CLI publishes an authenticated paged checkpoint');
  assert.equal(box.calls.some(call => call.method === 'DELETE'), false, 'local off does not send remote deletion without phone approval');
  assert.ok(box.calls.every(call => call.engine === String(ENGINE_VERSION)), 'every request from the real CLI carries the current engine version');
});
