/** @pullboard-test-loads relay/client.js src/changelog.js */
/** Exercise the deploy smoke script against a private loopback relay [H5,H18]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, reportFixtureChildFailure, safeFixtureDiagnostic } from './fixture-child.js';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { releaseHeadlinesBetween } from '../src/changelog.js';
import { ENGINE_VERSION, VERIFIER_STANDING_ENGINE } from '../src/machine.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { githubFixture } from './relay-fixture.js';
import { createRelayBrowserHandler } from '../relay/browser-page.js';
import { encodeBoardKey, generateBoardKey, seal, unseal } from '../src/seal.js';
import { createHash, randomBytes } from 'node:crypto';
import { createDeviceKeys, signDeviceEnrollment, unwrapDeviceBoardKey, wrapDeviceBoardKey } from '../src/relay-device-keys.js';
import { approvalContext, openApproval, sealApproval, signApprovalIntent, verifyApprovalIntent } from '../src/relay-approval.js';
import { RELAY_REQUEST_BOUND_MS } from './relay-budget.js';

const SMOKE = resolve(import.meta.dirname, '../relay/smoke.mjs');
const SERVER = resolve(import.meta.dirname, '../relay/server.mjs');
const DOCKERFILE = resolve(import.meta.dirname, '../relay/Dockerfile');
const README = resolve(import.meta.dirname, '../relay/README.md');
const ROOT = resolve(import.meta.dirname, '..');
const DAMAGED_SERVER_FAILURE_FLOOR_MS = 5000;

/** Copy one declared Docker source to its Dockerfile destination, optionally omitting a runtime file. */
function copyDockerSource(source, destinationPath, omitted) {
  if (omitted.has(source)) return;
  const sourcePath = join(ROOT, source);
  if (statSync(sourcePath).isDirectory()) {
    mkdirSync(destinationPath, { recursive: true });
    for (const entry of readdirSync(sourcePath)) copyDockerSource(join(source, entry), join(destinationPath, entry), omitted);
  } else {
    mkdirSync(join(destinationPath, '..'), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
}

/** Build an empty image root from exactly the sources named by Dockerfile COPY instructions. */
function copiedImage(t, omitted = []) {
  const image = mkdtempSync(join(tmpdir(), 'pullboard-relay-image-'));
  t.after(() => rmSync(image, { recursive: true, force: true }));
  const excluded = new Set(omitted);
  for (const line of readFileSync(DOCKERFILE, 'utf8').split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens[0] !== 'COPY') continue;
    const paths = tokens.slice(1).filter(token => !token.startsWith('--'));
    const destination = paths.pop();
    assert.ok(paths.length > 0 && destination, 'Docker COPY names at least one source and a destination');
    const destinationPath = join(image, destination.replace(/^\.\//u, '').replace(/\/$/u, ''));
    for (const source of paths) copyDockerSource(source.replace(/\/$/u, ''), destinationPath, excluded);
  }
  return image;
}

/** Verify the copied image carries the exact shipped notes consumed by its runtime helper. */
async function assertCopiedChangelog(image) {
  const shipped = readFileSync(join(ROOT, 'CHANGELOG.md'));
  const copied = readFileSync(join(image, 'CHANGELOG.md'));
  assert.deepEqual(copied, shipped, 'the production image includes byte-identical shipped release notes');
  const runtimeChangelog = await import(pathToFileURL(join(image, 'src/changelog.js')).href);
  assert.deepEqual(
    runtimeChangelog.releaseHeadlinesBetween('0.0.0', '99.99.99'),
    releaseHeadlinesBetween('0.0.0', '99.99.99'),
    'the copied runtime helper reads release headlines from the packaged notes',
  );
}

/** Start the copied production entry point with private fixture storage and no inherited selectors. */
function copiedServer(t, image, port, provider) {
  const privateHome = mkdtempSync(join(tmpdir(), 'pullboard-relay-image-home-'));
  const data = join(privateHome, 'data');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NODE_ENV: 'production',
    HOME: join(privateHome, 'home'), PULLBOARD_HOME: join(privateHome, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(privateHome, 'machine-home'), PULLBOARD_RELAY_DATA: data,
    PULLBOARD_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port),
    GITHUB_APP_CLIENT_ID: provider.config.clientId,
    GITHUB_APP_CLIENT_SECRET: provider.config.clientSecret,
    GITHUB_APP_PRIVATE_KEY: provider.config.privateKey,
  };
  mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(privateHome, { recursive: true, force: true }));
  const command = process.execPath;
  const args = [join(image, 'relay/server.mjs')];
  const started = performance.now();
  const child = spawn(command, args, { cwd: image, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  child.once('close', (status, signal) => {
    if (child.fixtureExpectedStop || (status === 0 && !signal)) return;
    child.fixtureFailure = reportFixtureChildFailure({ command, args, status, signal, elapsedMs: performance.now() - started, stderr, env });
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.fixtureExpectedStop = true;
    child.kill('SIGTERM');
    if (await childClosesWithin(child, 5000)) return;
    child.kill('SIGKILL');
    await childClosesWithin(child, 5000);
  });
  return { child, privateHome, startedAt: started, stderr: () => stderr };
}

/**
 * Boot the copied relay to health on a fresh port, retrying with another when it exits PORT_BUSY.
 * unusedPort() closes its socket before the relay listens, so another process can take the port in
 * between; under parallel gates that turned an unrelated submit red (#883). A final failure names
 * every port tried.
 *
 * @returns {Promise<{ child: any, privateHome: string, startedAt: number, origin: string, deadline: number, tried: { port: number, refused: string | null }[] }>}
 */
async function bootCopiedServer(t, image, provider, { pickPort = unusedPort, attempts = 3 } = {}) {
  const tried = [];
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await pickPort();
    const origin = `http://127.0.0.1:${port}`;
    const running = copiedServer(t, image, port, provider);
    const deadline = Date.now() + 5000;
    if (await copiedServerHealthy(running.child, origin, deadline)) {
      tried.push({ port, refused: null });
      return { ...running, origin, deadline, tried };
    }
    await childClosesWithin(running.child, 5000);
    last = running.stderr();
    const busy = /\[PORT_BUSY\]/u.test(last);
    tried.push({ port, refused: busy ? 'PORT_BUSY' : null });
    if (!busy) break;
  }
  return assert.fail(`the copied relay did not reach health on ports ${tried.map(({ port, refused }) => `${port}${refused ? ` (${refused})` : ''}`).join(', ')}; last stderr: ${safeFixtureDiagnostic(last)}`);
}

/** Fetch with the remaining portion of the copied server's shared readiness deadline. */
function fetchBeforeDeadline(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('the copied relay exceeded its five-second readiness budget');
  return fetch(url, { signal: AbortSignal.timeout(remaining) });
}

/** Stop waiting once a copied entry point exits or its private readiness route answers. */
async function copiedServerHealthy(child, origin, deadline) {
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetchBeforeDeadline(new URL('/health', origin), deadline);
      if (response.status === 200 && (await response.text()) === 'ok\n') return true;
    } catch { /* The copied entry point is still starting. */ }
    await new Promise(ready => setTimeout(ready, 25));
  }
  return false;
}

/** Wait a bounded interval for the process close event. */
function childClosesWithin(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(ready => {
    const closed = () => {
      clearTimeout(timer);
      ready(true);
    };
    const timer = setTimeout(() => {
      child.off('close', closed);
      ready(false);
    }, milliseconds);
    child.once('close', closed);
  });
}

/** Wait for an omitted Docker source and retain the observed exit or elapsed timeout. */
async function copiedServerFailure(child, budgetMs) {
  const started = performance.now();
  if (child.exitCode === null && !await childClosesWithin(child, budgetMs)) {
    return { code: null, description: `still running after ${Math.round(performance.now() - started)} ms (budget ${budgetMs} ms)` };
  }
  return { code: child.exitCode, description: `exited ${child.exitCode}` };
}

/** Compare a rounded wait against its budget, allowing Node's whole-millisecond timer granularity. */
function damagedServerWaitMeetsBudget(elapsedMs, budgetMs) {
  return elapsedMs >= budgetMs - 1;
}

/** Require the Docker omission to fail before startup, naming the missing source and observed outcome. */
async function requireCopiedServerFailure(child, budgetMs, omitted) {
  const outcome = await copiedServerFailure(child, budgetMs);
  assert.ok(Number.isInteger(outcome.code) && outcome.code > 0,
    `omitting ${omitted} from the Dockerfile copy must cause a real nonzero startup exit; observed ${outcome.description}`);
  return outcome.code;
}

/** Scale the damaged-copy wait to this test's healthy boot while retaining a useful minimum. */
function damagedServerFailureBudget(healthyBootMs) {
  return Math.max(DAMAGED_SERVER_FAILURE_FLOOR_MS, Math.ceil(healthyBootMs * 3));
}

/** Start an isolated child whose only behavior is determined by the supplied Node script. */
function standInServer(t, script) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await childClosesWithin(child, 1000)) return;
    child.kill('SIGKILL');
    await childClosesWithin(child, 1000);
  });
  return child;
}

/** Extract a documented setting so the checklist can be checked against executable config. */
function setting(text, pattern, description) {
  const match = pattern.exec(text);
  assert.ok(match, `README deployment checklist must state ${description}`);
  return match[1];
}

/** Run the checked-in smoke script in a private real repository without retaining its output. */
function runSmoke(box, address) {
  return new Promise((resolveResult, reject) => {
    const command = process.execPath;
    const args = [SMOKE, address];
    const started = performance.now();
    const child = spawn(command, args, { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let safeFailure = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => {
      stderr += part;
      const line = part.split('\n').find((entry) => entry.startsWith('relay smoke failed:'));
      if (line) safeFailure = safeFixtureDiagnostic(line, box.env);
    });
    child.once('error', (error) => {
      reportFixtureChildFailure({ command, args, status: null, signal: null, elapsedMs: performance.now() - started, stderr, env: box.env, detail: error.message });
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (signal) {
        const failure = reportFixtureChildFailure({ command, args, status: code, signal, elapsedMs: performance.now() - started, stderr, env: box.env, detail: safeFailure || 'smoke process ended before producing a safe summary' });
        return reject(new Error(failure));
      }
      if (code !== 0) {
        const failure = reportFixtureChildFailure({ command, args, status: code, signal, elapsedMs: performance.now() - started, stderr, env: box.env, detail: safeFailure });
        return resolveResult({ code, failure });
      }
      try { resolveResult({ code, result: JSON.parse(stdout) }); }
      catch (error) {
        const failure = reportFixtureChildFailure({ command, args, status: code, signal, elapsedMs: performance.now() - started, stderr, env: box.env, detail: `smoke produced invalid safe summary: ${error.message}` });
        reject(new Error(failure));
      }
    });
  });
}

/** Reserve and release an ephemeral loopback port for the real deployment entry point. */
async function unusedPort() {
  const server = createServer();
  await new Promise((ready, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  await new Promise((ready) => server.close(ready));
  return port;
}

/** Wait for the child's private health route while failing promptly if startup exits. */
async function waitHealthy(child, origin) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('the relay container entry point exited before health became ready');
    try {
      const response = await fetch(new URL('/health', origin));
      if (response.status === 200 && (await response.text()) === 'ok\n') return;
    } catch { /* The local listener is not ready yet. */ }
    await new Promise((ready) => setTimeout(ready, 25));
  }
  throw new Error('the relay container entry point did not become healthy');
}

test('[H5,H18] the Railway checklist matches the container and relay runtime settings', () => {
  const readme = readFileSync(README, 'utf8');
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const server = readFileSync(SERVER, 'utf8');
  const volume = setting(readme, /Attach one Railway\s+volume at `([^`]+)`/u, 'the persistent volume path');
  const authDatabase = setting(readme, /auth database at\s+`([^`]+)`/u, 'the auth database path');
  const boardsDirectory = setting(readme, /board journals under\s+`([^`]+)`/u, 'the board journal directory');
  const backupsDirectory = setting(readme, /private backups under\s+`([^`]+)`/u, 'the private backup directory');
  const startCommand = setting(readme, /set the start command to\s+`([^`]+)`/u, 'the start command');
  const healthPath = setting(readme, /health check path to `([^`]+)`/u, 'the health check path');
  const portVariable = setting(readme, /service listens on\s+Railway's `([^`]+)`/u, 'the assigned port variable');
  const serverPort = /Number\(process\.env\.([A-Z_]+) \|\| (\d+)\)/u.exec(server);
  const dockerPort = /process\.env\.([A-Z_]+)\|\|(\d+)/u.exec(dockerfile);

  assert.equal(authDatabase, `${volume}/auth.sqlite`);
  assert.equal(boardsDirectory.replace(/\/+$/u, ''), `${volume}/boards`);
  assert.equal(backupsDirectory.replace(/\/+$/u, ''), `${volume}/backups`);
  assert.ok(dockerfile.includes(`PULLBOARD_RELAY_DATA=${volume}`), 'Docker defaults storage to the documented volume');
  assert.ok(server.includes(`resolve(process.env.PULLBOARD_RELAY_DATA || '${volume}')`), 'server reads the same volume path');
  assert.ok(server.includes("database: join(data, 'auth.sqlite')"), 'auth database is inside the volume');
  assert.ok(server.includes("directory: join(data, 'boards')"), 'board journals are inside the volume');
  assert.ok(server.includes("backupsDirectory: join(data, 'backups')"), 'backups are inside the volume');

  assert.equal(portVariable, 'PORT');
  assert.ok(serverPort, 'server reads its assigned port and declares a numeric fallback');
  assert.ok(dockerPort, 'container health probe reads the assigned port and declares a fallback');
  const defaultPort = Number(serverPort[2]);
  assert.equal(serverPort[1], portVariable);
  assert.equal(dockerPort[1], portVariable);
  assert.equal(Number(dockerPort[2]), defaultPort, 'container health probe and server share the same fallback port');
  assert.ok(Number.isInteger(defaultPort));
  assert.ok(dockerfile.includes(`EXPOSE ${defaultPort}`), 'container exposes the server fallback port');
  assert.equal(healthPath, '/health');
  assert.ok(server.includes(`pathname !== '${healthPath}'`), 'server serves the documented readiness path');
  assert.ok(dockerfile.includes(`'${healthPath}'`), 'container probes the documented readiness path');
  assert.equal(startCommand, 'node relay/server.mjs');
  assert.ok(dockerfile.includes('CMD ["node", "relay/server.mjs"]'), 'container starts the documented entry point');
});

test('[H5,H18] the Railway smoke links, reads one unsealed move and unlinks locally', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal(await box.requireEngineThree(), VERIFIER_STANDING_ENGINE, `a machine-linked board requires the engine-${VERIFIER_STANDING_ENGINE} seat-provenance replay engine`);
  const previous = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const legacy = await fetch(`${previous.url}/api/v1/boards/${previous.board}/state`, {
    headers: { authorization: `Bearer ${previous.token}`, 'x-pullboard-engine': '2' },
  });
  assert.equal(legacy.status, 400, 'the durable agent-token minimum refuses an engine-2 reader');
  assert.equal((await legacy.json()).error.code, 'ENGINE_VERSION');
  assert.equal((await box.cli('relay', 'off')).code, 0);
  const phone = await box.phoneSession();
  assert.equal(box.auth.boardOff(previous.board), null,
    'local relay off retains the active predecessor until the authenticated relink replaces it');
  const beforeSmoke = box.calls.length;

  const smoke = await runSmoke(box, previous.url);
  assert.equal(smoke.code, 0, smoke.failure);
  const result = smoke.result;
  assert.equal(result.ok, true);
  assert.match(result.board, /^[0-9a-f]{32}$/u, 'the smoke identifies its actual remote board');
  assert.notEqual(result.board, previous.board, 'relinking after relay off creates a fresh remote board');
  assert.equal(box.auth.boardOff(previous.board)?.replacedBy, result.board,
    'the smoke relink turns its actual predecessor off with a receipt naming the new board');
  assert.equal(box.auth.boardOff(result.board), null, 'the smoke keeps exactly the replacement link active');
  assert.equal(typeof result.item, 'number');
  assert.equal(result.sequence, 1);
  assert.equal(existsSync(box.linkFile), false, 'relay off forgets the private link metadata');
  assert.equal(existsSync(box.keyFile), false, 'relay off forgets the device-only board key');
  assert.equal(box.calls.slice(beforeSmoke).some(call => call.method === 'DELETE'), false,
    'the smoke only unlinks locally and cannot delete the relay copy without phone approval');
  assert.equal(result.remoteCopyRetained, true);
  assert.match(result.notice, /relay copy stays until you approve deleting it on your phone/u);
  const retained = await fetch(`${previous.url}/api/v2/boards/${result.board}/state`, {
    headers: { authorization: `Bearer ${phone.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(retained.status, 200, 'local smoke cleanup retains the sealed relay copy for explicit phone deletion');
  const smokeReads = box.calls.slice(beforeSmoke).filter((call) => call.method === 'GET'
    && new RegExp(`^/api/v[12]/boards/${result.board}/(?:events|state)(?:\\?|$)`, 'u').test(call.path));
  assert.ok(smokeReads.length >= 2, 'the smoke reads the mirrored event and its native checkpoint over the real HTTP API');
  assert.ok(smokeReads.every((call) => call.engine === String(ENGINE_VERSION)), 'every smoke board-content read declares the current engine after the relay minimum is raised');
  const local = (await box.cli('export')).document;
  assert.ok(local.tables.item.some((item) => item.item_id === result.item && item.item_title.startsWith('Pullboard relay smoke ')),
    'the real CLI move remains in the local board after relay off');
});

test('[H5,H18] a linked repository is refused before the smoke can unlink its board', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const previous = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const before = box.calls.length;
  const smoke = await runSmoke(box, previous.url);
  assert.notEqual(smoke.code, 0);
  assert.match(smoke.failure, /already has a relay link/);
  assert.equal(box.calls.length, before, 'the guard runs before relay on or off can make a network request');
  assert.equal(existsSync(box.linkFile), true, 'the existing private link remains intact');
  assert.equal(existsSync(box.keyFile), true, 'the existing device key remains intact');
  const state = await fetch(`${previous.url}/api/v2/boards/${previous.board}/state`, {
    headers: { authorization: `Bearer ${previous.token}`, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(state.status, 200, 'the linked remote board was not deleted');
});

test('[H5,H18] the container entry point serves readiness and stays available', async (t) => {
  const provider = await githubFixture(t);
  const data = mkdtempSync(join(tmpdir(), 'pullboard-relay-deploy-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    PULLBOARD_RELAY_DATA: data,
    PULLBOARD_PUBLIC_ORIGIN: origin,
    GITHUB_APP_CLIENT_ID: provider.config.clientId,
    GITHUB_APP_CLIENT_SECRET: provider.config.clientSecret,
    GITHUB_APP_PRIVATE_KEY: provider.config.privateKey,
  };
  const command = process.execPath;
  const args = [SERVER];
  const started = performance.now();
  const child = spawn(command, args, { cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  child.once('close', (status, signal) => {
    if (child.fixtureExpectedStop || (status === 0 && !signal)) return;
    child.fixtureFailure = reportFixtureChildFailure({ command, args, status, signal, elapsedMs: performance.now() - started, stderr, env });
  });
  t.after(async () => {
    if (child.exitCode === null) { child.fixtureExpectedStop = true; child.kill('SIGTERM'); }
    if (child.exitCode === null) await new Promise((ready) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); ready(); }, 5000);
      child.once('close', () => { clearTimeout(timer); ready(); });
    });
  });
  await waitHealthy(child, origin);
  assert.equal(child.exitCode, null, 'the long-running relay remains available after its health probe');
});

const REDEPLOY_GITHUB_HOSTS = ['https://github.com', 'https://api.github.com'];

/**
 * Write a preload that sends the production entry point's GitHub calls to the loopback provider.
 * The relay keeps its real GitHub client; this only swaps the network target, and refuses any
 * request that would leave the machine, so a drill can never reach a real deployment.
 */
function loopbackGitHubPreload(folder) {
  const file = join(folder, 'loopback-github.mjs');
  writeFileSync(file, [
    '/** Route the relay\'s GitHub requests to the private loopback provider and refuse every other host. */',
    'const target = new URL(process.env.PULLBOARD_DRILL_GITHUB_ORIGIN);',
    'const real = globalThis.fetch;',
    `const hosts = new Set(${JSON.stringify(REDEPLOY_GITHUB_HOSTS)});`,
    'globalThis.fetch = (input, init) => {',
    '  let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);',
    '  if (hosts.has(url.origin)) url = new URL(url.pathname + url.search, target);',
    '  if (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return Promise.reject(new Error("the redeploy drill stays on loopback"));',
    '  return real(url, init);',
    '};',
  ].join('\n'), { mode: 0o600 });
  return file;
}

/**
 * Start the production relay entry point as its own process on one data directory and port.
 * A redeploy is exactly this: a new process, the same volume, the same public address.
 */
async function startRelayProcess(t, { data, port, provider, preload, home }) {
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production', HOME: home,
    PULLBOARD_HOME: join(home, 'pullboard-home'), PULLBOARD_MACHINE_HOME: join(home, 'machine-home'),
    PULLBOARD_RELAY_DATA: data, PULLBOARD_PUBLIC_ORIGIN: origin, PORT: String(port),
    PULLBOARD_DRILL_GITHUB_ORIGIN: provider.origin,
    GITHUB_APP_CLIENT_ID: provider.config.clientId,
    GITHUB_APP_CLIENT_SECRET: provider.config.clientSecret,
    GITHUB_APP_PRIVATE_KEY: provider.config.privateKey,
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, SERVER], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await childClosesWithin(child, 5000); // budget: cleanup ceiling for a relay a failed drill left running.
  });
  await waitHealthy(child, origin);
  return { child, origin };
}

/** Stop a relay the way a platform redeploy does: SIGTERM, then wait for its own clean shutdown. */
async function stopRelayProcess(relay) {
  relay.child.kill('SIGTERM');
  const closed = await childClosesWithin(relay.child, 10_000); // budget: graceful SIGTERM shutdown closes SQLite and the listener.
  if (!closed) relay.child.kill('SIGKILL');
  return { closed, code: relay.child.exitCode, signal: relay.child.signalCode };
}

/** Send one JSON request to a drill relay with a bearer credential; the credential never enters a message. */
async function relayCall(origin, path, { method = 'GET', token, body, engine = true } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (engine) headers['x-pullboard-engine'] = String(ENGINE_VERSION);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_REQUEST_BOUND_MS) }); // budget: one relay request bound, shared with the other relay fixtures.
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Read one cookie value from a response's Set-Cookie headers. */
function setCookie(response, name) {
  for (const line of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*)`, 'u').exec(line);
    if (match) return match[1];
  }
  return null;
}

/** Sign a person in through the relay's real GitHub web flow, answered by the loopback provider. */
async function signInPerson(origin, provider) {
  const start = await fetch(origin + '/auth/github/start', { redirect: 'manual' });
  assert.equal(start.status, 302, 'the relay starts a GitHub web sign-in');
  const binding = setCookie(start, 'pb_oauth_binding');
  const authorize = new URL(start.headers.get('location'));
  const granted = await fetch(provider.origin + authorize.pathname + authorize.search, { redirect: 'manual' });
  assert.equal(granted.status, 303, 'the loopback provider grants the sign-in');
  const callback = await fetch(granted.headers.get('location'), { redirect: 'manual', headers: { cookie: 'pb_oauth_binding=' + binding } });
  assert.equal(callback.status, 303, 'the relay finishes the sign-in');
  const token = setCookie(callback, 'pb_session');
  assert.match(token ?? '', /^ps_[A-Za-z0-9_-]{43}$/u, 'the relay sets a person session');
  const session = await relayCall(origin, '/auth/session', { token, engine: false });
  assert.equal(session.status, 200);
  return { token, id: session.body.session.id };
}

/** Encode a JSON value as the canonical base64url transport the relay stores without parsing. */
function opaque(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Decode a relay-stored base64url JSON transport back into its value. */
function unopaque(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

/** Seal a board record with the board key, bound to its board, kind and sequence. */
async function sealRecord(key, board, kind, sequence, value) {
  return Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(value)), { boardId: board, kind, sequence })).toString('base64url');
}

/** Unseal a relay-held board record and parse its JSON contents. */
async function unsealRecord(key, board, kind, sequence, sealed) {
  return JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(sealed, 'base64url'), { boardId: board, kind, sequence })));
}

/**
 * Link a board, sign a person in, enroll a phone and publish one sealed approval on a fresh relay.
 * Every step uses the relay's public HTTP routes, the way the Mac and the phone use them.
 */
async function pairEverything(origin, provider) {
  const board = createHash('sha256').update('redeploy-drill-board').digest('hex').slice(0, 32);
  const machine = 'redeploy-drill-mac';
  const person = await signInPerson(origin, provider);
  const linked = await relayCall(origin, '/auth/boards/link', { method: 'POST', token: person.token, engine: false, body: { board, repository: 'fixture/repository' } });
  assert.equal(linked.status, 200, 'the person links the board');
  const issued = await relayCall(origin, '/auth/machines', { method: 'POST', token: person.token, engine: false, body: { board, machine } });
  assert.equal(issued.status, 201, 'the person issues the Mac its board machine credential');
  const mac = issued.body.token;

  const key = await generateBoardKey();
  const snapshotValue = { version: 1, drill: 'snapshot before the redeploy' };
  const snapshot = await sealRecord(key, board, 'snapshot', 0, snapshotValue);
  assert.equal((await relayCall(origin, `/api/v1/boards/${board}/state`, { method: 'PUT', token: mac, body: { sequence: 0, sealed: snapshot } })).status, 200, 'the Mac uploads the sealed snapshot');
  const firstMove = await sealRecord(key, board, 'move', 1, { drill: 'move one' });
  const moved = await relayCall(origin, `/api/v1/boards/${board}/moves`, { method: 'POST', token: mac, body: { sequence: 1, sealed: firstMove } });
  assert.equal(moved.status, 200, 'the Mac publishes its first sealed move');

  const account = (await relayCall(origin, '/api/v1/devices/session', { token: person.token, engine: false })).body.account;
  const phone = await createDeviceKeys();
  const locator = randomBytes(16).toString('base64url');
  const secret = randomBytes(32);
  assert.equal((await relayCall(origin, `/api/v1/devices/enrollments/${locator}`, { method: 'POST', token: person.token, engine: false, body: {} })).status, 200, 'the Mac opens a one-use phone pairing');
  const enrollment = await signDeviceEnrollment(secret, { v: 1, account, locator, deviceId: phone.deviceId, publicKey: phone.publicKey, label: 'Drill phone', createdAt: new Date().toISOString() });
  assert.equal((await relayCall(origin, `/api/v1/devices/enrollments/${locator}`, { method: 'PUT', token: person.token, engine: false, body: enrollment })).status, 200, 'the phone posts its signed enrollment');
  assert.equal((await relayCall(origin, `/api/v1/devices/${phone.deviceId}`, { method: 'POST', token: person.token, engine: false, body: {} })).status, 200, 'the Mac registers the authenticated phone');
  const wrap = await wrapDeviceBoardKey(key, phone.publicKey, { board, device: phone.deviceId, engine: ENGINE_VERSION });
  assert.equal((await relayCall(origin, `/api/v1/devices/${phone.deviceId}/boards/${board}`, { method: 'PUT', token: mac, body: { engine: ENGINE_VERSION, wrapped: opaque(wrap) } })).status, 200, 'the Mac wraps the board key to the phone');
  assert.equal((await relayCall(origin, `/api/v1/devices/enrollments/${locator}`, { method: 'DELETE', token: person.token, engine: false })).status, 200, 'the one-use pairing is consumed');

  const context = approvalContext({ id: 'redeploy-drill-approval', account, publisher: board, board, device: phone.deviceId,
    action: 'revoke-token', target: 'redeploy-drill-token', machine, command: 'pullboard relay revoke redeploy-drill-token', expires: Date.now() + 600_000 });
  const envelope = await sealApproval({ context, drill: 'approval before the redeploy' }, phone.publicKey, context, 'intent');
  const sealedApproval = opaque({ envelope, mac: await signApprovalIntent(key, envelope) });
  const published = await relayCall(origin, '/api/v1/devices/approvals', { method: 'POST', token: mac, body: { context, sealed: sealedApproval } });
  assert.equal(published.status, 200, 'the Mac publishes a sealed approval for the phone');
  return { board, machine, person, mac, key, account, phone, snapshot, snapshotValue, firstMove, context, sealedApproval };
}

/** Read what the phone sees: its waiting approvals and its board key, opened with its own private key. */
async function phoneReads(origin, paired) {
  const inbox = await relayCall(origin, `/api/v1/devices/${paired.phone.deviceId}/approvals`, { token: paired.person.token, engine: false });
  const wraps = await relayCall(origin, `/api/v1/devices/${paired.phone.deviceId}/boards`, { token: paired.person.token, engine: false });
  return { inbox, wraps };
}

test('a relay redeploy keeps every pairing, session and board [H5,H7,H15]', { timeout: 120_000 }, async (t) => { // budget: three relay boots, two shutdowns and about forty loopback requests.
  const provider = await githubFixture(t);
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-relay-redeploy-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const volume = join(scratch, 'volume');
  const freshVolume = join(scratch, 'fresh-volume');
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const preload = loopbackGitHubPreload(scratch);
  const port = await unusedPort();

  const first = await startRelayProcess(t, { data: volume, port, provider, preload, home });
  const paired = await pairEverything(first.origin, provider);
  const before = await phoneReads(first.origin, paired);
  assert.deepEqual(before.inbox.body.approvals.map(row => row.context.id), [paired.context.id], 'the phone sees the approval before the redeploy');
  const stopped = await stopRelayProcess(first);
  assert.deepEqual(stopped, { closed: true, code: 0, signal: null }, 'the old relay shuts down cleanly on SIGTERM, as a redeploy stops it'); // budget: graceful SIGTERM shutdown closes SQLite and the listener.

  const second = await startRelayProcess(t, { data: volume, port, provider, preload, home });
  const callsBefore = provider.calls.length;
  const origin = second.origin;

  const session = await relayCall(origin, '/auth/session', { token: paired.person.token, engine: false });
  assert.equal(session.status, 200, 'REDEPLOY_SESSION: the person session still authenticates after the redeploy');
  assert.equal(session.body.session.id, paired.person.id, 'the redeploy keeps the same session, not a new sign-in');
  assert.equal(session.body.session.user.id, paired.account);
  const machine = await relayCall(origin, `/auth/session?board=${paired.board}`, { token: paired.mac, engine: false });
  assert.equal(machine.status, 200, 'REDEPLOY_MACHINE: the Mac machine credential still authenticates for its board, with no re-link');
  assert.equal(machine.body.session.machine, paired.machine);
  const listed = await relayCall(origin, '/auth/boards', { token: paired.person.token, engine: false });
  assert.deepEqual(listed.body.boards.map(row => row.id), [paired.board], 'the board is still linked');

  const after = await phoneReads(origin, paired);
  assert.equal(after.inbox.status, 200, 'REDEPLOY_DEVICE: the paired phone still reads its approvals after the redeploy');
  assert.deepEqual(after.inbox.body.approvals.map(row => row.context.id), [paired.context.id], 'the waiting approval survives the redeploy');
  assert.equal(after.inbox.body.approvals[0].sealed, paired.sealedApproval, 'the sealed approval bytes are unchanged');
  const packet = unopaque(after.inbox.body.approvals[0].sealed);
  assert.equal(after.wraps.status, 200, 'the phone still reads its wrapped board key');
  const wrap = after.wraps.body.wraps.find(row => row.board === paired.board);
  const phoneKey = await unwrapDeviceBoardKey(paired.phone.privateKey, unopaque(wrap.wrapped), { board: paired.board, device: paired.phone.deviceId, engine: ENGINE_VERSION });
  assert.deepEqual(phoneKey, paired.key, 'the phone opens the same board key with its own private key, with no re-pair');
  assert.deepEqual(await verifyApprovalIntent(phoneKey, packet), packet.envelope, 'the approval still authenticates with the phone board key');
  const opened = await openApproval(paired.phone.privateKey, packet.envelope, paired.context, 'intent');
  assert.equal(opened.drill, 'approval before the redeploy', 'the phone opens the sealed approval it was sent before the redeploy');

  const state = await relayCall(origin, `/api/v1/boards/${paired.board}/state`, { token: paired.person.token });
  assert.equal(state.status, 200, 'REDEPLOY_BOARD: the board snapshot is still served after the redeploy');
  assert.equal(state.body.state.sequence, 0);
  assert.equal(state.body.state.sealed, paired.snapshot, 'the sealed snapshot bytes are intact');
  assert.deepEqual(await unsealRecord(phoneKey, paired.board, 'snapshot', 0, state.body.state.sealed), paired.snapshotValue);
  const events = await relayCall(origin, `/api/v1/boards/${paired.board}/events?after=0`, { token: paired.mac });
  assert.deepEqual(events.body.events.map(row => [row.event_id, row.sealed]), [[1, paired.firstMove]], 'the board sequence is intact at one sealed move');

  const nextMove = await sealRecord(paired.key, paired.board, 'move', 2, { drill: 'move after the redeploy' });
  const moved = await relayCall(origin, `/api/v1/boards/${paired.board}/moves`, { method: 'POST', token: paired.mac, body: { sequence: 2, sealed: nextMove } });
  assert.equal(moved.status, 200, 'REDEPLOY_MOVE: a new move is accepted after the redeploy');
  assert.equal(moved.body.result.sequence, 2, 'the new move continues the sequence instead of restarting it');
  const read = await relayCall(origin, `/api/v1/boards/${paired.board}/events?after=1`, { token: paired.person.token });
  assert.deepEqual(read.body.events.map(row => row.event_id), [2]);
  assert.deepEqual(await unsealRecord(phoneKey, paired.board, 'move', 2, read.body.events[0].sealed), { drill: 'move after the redeploy' }, 'the new move round-trips');
  assert.equal(provider.calls.slice(callsBefore).some(call => call.path.startsWith('/login/')), false, 'nobody signed in again after the redeploy');
  await stopRelayProcess(second);

  const control = await startRelayProcess(t, { data: freshVolume, port, provider, preload, home });
  const lost = await relayCall(control.origin, '/auth/session', { token: paired.person.token, engine: false });
  assert.equal(lost.status, 401, 'CONTROL: a relay without the old volume refuses the old session');
  assert.equal(lost.body.error.code, 'AUTH_REQUIRED');
  assert.equal((await relayCall(control.origin, `/auth/session?board=${paired.board}`, { token: paired.mac, engine: false })).status, 401, 'CONTROL: the Mac would have to link again');
  const again = await signInPerson(control.origin, provider);
  const unpaired = await phoneReads(control.origin, { ...paired, person: again });
  assert.equal(unpaired.inbox.body.error?.code, 'DEVICE_NOT_ENROLLED', 'CONTROL: the phone would have to pair again');
  assert.deepEqual((await relayCall(control.origin, '/auth/boards', { token: again.token, engine: false })).body.boards, [], 'CONTROL: no board is linked on a fresh volume');
  await stopRelayProcess(control);
});

test('[H5,H18] Docker COPY sources boot the relay and serve its browser page, while omitted runtime files refuse startup', async (t) => {
  const provider = await githubFixture(t);
  const image = copiedImage(t);
  await assertCopiedChangelog(image);
  // The Dockerfile-only copy starts the production entry point and reaches health.
  const running = await bootCopiedServer(t, image, provider);
  const { origin, deadline } = running;
  const failureBudgetMs = damagedServerFailureBudget(performance.now() - running.startedAt);
  const page = await fetchBeforeDeadline(origin, deadline);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in to see your linked boards/u, 'the copied image serves the browser page');
  const browser = await fetchBeforeDeadline(new URL('/relay/client.js', origin), deadline);
  assert.equal(browser.status, 200);
  assert.match(await browser.text(), /rememberPairing/u, 'the browser route serves its runtime client asset');
  assert.equal(running.child.exitCode, null, 'the copied relay stays alive after serving browser routes');
  assert.equal(running.child.signalCode, null, 'the copied relay was not stopped by a probe timeout');
  assert.equal(existsSync(join(running.privateHome, 'data', 'auth.sqlite')), true, 'the private auth database was created in its configured volume');

  for (const omitted of [
    'src/cockpit.js',
    'src/machine.js',
    'src/view.css',
    'src/seal.js',
    'relay/browser-client.js',
    'relay/browser-model.js',
    'src/refused.js',
  ]) {
    const damagedImage = copiedImage(t, [omitted]);
    const damagedPort = await unusedPort();
    const damaged = copiedServer(t, damagedImage, damagedPort, provider);
    await requireCopiedServerFailure(damaged.child, failureBudgetMs, omitted);
  }
});

test('[H5,H18] a copied relay whose port was taken retries on a fresh one, naming every port tried', async (t) => {
  const provider = await githubFixture(t);
  const image = copiedImage(t);
  const holders = [];
  t.after(() => Promise.all(holders.map((server) => new Promise((ready) => server.close(ready)))));
  /** Take a port on the relay's own wildcard address and keep it, as another process can before the relay listens. */
  const heldPort = async () => {
    const server = createServer();
    await new Promise((ready, fail) => { server.once('error', fail); server.listen(0, '0.0.0.0', ready); });
    holders.push(server);
    return server.address().port;
  };
  let picks = 0;
  const booted = await bootCopiedServer(t, image, provider, { pickPort: () => (picks++ === 0 ? heldPort() : unusedPort()) });
  assert.equal(booted.tried.length, 2, 'one retry after the held port');
  assert.equal(booted.tried[0].refused, 'PORT_BUSY', 'the first attempt is refused PORT_BUSY on the held port');
  assert.equal(booted.tried[1].refused, null, 'the retry boots');
  assert.equal((await fetchBeforeDeadline(new URL('/health', booted.origin), booted.deadline)).status, 200);

  const held = [];
  await assert.rejects(
    bootCopiedServer(t, image, provider, { pickPort: async () => { const port = await heldPort(); held.push(port); return port; } }),
    (error) => held.length === 3 && held.every((port) => error.message.includes(`${port} (PORT_BUSY)`)),
    'a final failure names every port tried',
  );
});

test('[H5,H18] a damaged relay copy is judged by its own boot time', { timeout: 30_000 }, async (t) => {
  const budgetMs = DAMAGED_SERVER_FAILURE_FLOOR_MS;
  assert.ok(damagedServerFailureBudget(budgetMs) > budgetMs, 'a slower healthy boot extends the damaged-copy budget above its stated floor');
  const slowFailure = standInServer(t, 'setTimeout(() => process.exit(7), 1700)');
  const slowCode = await requireCopiedServerFailure(slowFailure, budgetMs, 'src/relay/browser-model.js');
  assert.equal(slowCode, 7, 'a real failure later than the old 1,500 ms cutoff is still observed');

  const neverExits = standInServer(t, 'setInterval(() => {}, 1000)');
  let neverMessage = '';
  await assert.rejects(
    requireCopiedServerFailure(neverExits, budgetMs, 'src/relay/browser-model.js'),
    (error) => {
      neverMessage = error.message;
      return /omitting src\/relay\/browser-model\.js .*still running after (\d+) ms \(budget 5000 ms\)/u.test(error.message);
    },
    'a damaged copy that never exits names the omitted file and its observed timeout',
  );
  const elapsed = Number(/still running after (\d+) ms/u.exec(neverMessage)?.[1]);
  assert.ok(damagedServerWaitMeetsBudget(elapsed, budgetMs), `the reported elapsed wait ${elapsed} ms reached the ${budgetMs} ms budget (allowing one millisecond for timer granularity)`);
  const exitsZero = standInServer(t, 'setImmediate(() => process.exit(0))');
  await assert.rejects(
    requireCopiedServerFailure(exitsZero, budgetMs, 'src/relay/browser-model.js'),
    /omitting src\/relay\/browser-model\.js .*exited 0/u,
    'a clean exit is identified as not being a startup failure',
  );
});

test('a timer that fires a millisecond early still meets the damaged-copy budget [H18,C7]', () => {
  const budgetMs = DAMAGED_SERVER_FAILURE_FLOOR_MS;
  assert.equal(damagedServerWaitMeetsBudget(budgetMs - 1, budgetMs), true, 'one millisecond early fits timer granularity');
  assert.equal(damagedServerWaitMeetsBudget(budgetMs - 2, budgetMs), false, 'two milliseconds early remains below budget');
});

/** Read one relay browser asset through the production handler, without a network listener. */
async function servedAsset(handler, path) {
  let status = 0;
  let body = '';
  const handled = await handler({ method: 'GET', url: path }, { writeHead(code) { status = code; }, end(content) { body = String(content); } });
  assert.equal(handled, true, `the relay browser handler owns ${path}`);
  assert.equal(status, 200, `the relay browser handler serves ${path}`);
  return body;
}

/** Write the served relay client module graph to a private folder, so Node imports exactly what a browser loads. */
async function servedRelayClient(t) {
  const folder = mkdtempSync(join(tmpdir(), 'pullboard-relay-client-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'relay'));
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Error('relay assets need no session'); } });
  const pending = ['client.js'];
  const written = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (written.has(name)) continue;
    written.add(name);
    const source = await servedAsset(handler, '/relay/' + name);
    writeFileSync(join(folder, 'relay', name), source);
    for (const match of source.matchAll(/from\s+['"]\.\/([\w.-]+\.js)['"]/gu)) pending.push(match[1]);
  }
  return import(pathToFileURL(join(folder, 'relay', 'client.js')).href);
}

/** Install a browser page whose storage refuses every write and whose relay serves one sealed board. */
function refusingStoragePage(t, { hash, board, sealed }) {
  const refused = [];
  const unexpected = [];
  const replaced = [];
  let snapshotReads = 0;
  let approvalReads = 0;
  /** Model storage that refuses writes, as a private window or a full quota does. */
  const storage = () => ({
    length: 0, key: () => null, getItem: () => null,
    setItem(name) { refused.push(name); throw new DOMException('Storage refused this write.', 'QuotaExceededError'); },
    removeItem(name) { refused.push(name); throw new DOMException('Storage refused this write.', 'QuotaExceededError'); },
  });
  const events = new EventTarget();
  const location = { origin: 'https://relay.example', pathname: '/', search: '', hash, replace(path) { replaced.push(path); } };
  /** Answer one JSON relay document. */
  const reply = (document, status = 200, headers = {}) => new Response(JSON.stringify(document), { status, headers: { 'content-type': 'application/json', ...headers } });
  /** Model an IndexedDB that holds no phone key, so only the pairing link can open the board. */
  const indexedDB = {
    open() {
      const db = {
        close() {},
        transaction() {
          const transaction = {
            objectStore: () => ({ get() {
              const request = {};
              queueMicrotask(() => { request.onsuccess?.(); transaction.oncomplete?.(); });
              return request;
            } }),
          };
          return transaction;
        },
      };
      const request = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const globals = {
    location,
    history: { replaceState(state, title, path) { const url = new URL(path, location.origin); location.pathname = url.pathname; location.search = url.search; location.hash = url.hash; } },
    sessionStorage: storage(), localStorage: storage(), indexedDB,
    document: { getElementById: () => null, querySelector: () => null, documentElement: { dataset: {} } },
    addEventListener: (type, listener, options) => events.addEventListener(type, listener, options),
    /** Serve only the listing, one sealed snapshot, an empty prefix and a live stream that waits until the page hides. */
    fetch: async (input, init = {}) => {
      const url = new URL(String(input), location.origin);
      const accept = new Headers(init.headers).get('accept');
      if (url.pathname === '/api/v1/boards') return reply({ version: 1, boards: [{ id: board, repository: 'acme/widgets' }] });
      if (url.pathname === '/api/v1/devices/exclusions') return reply({ version: 1, exclusions: [] });
      if (url.pathname === '/api/v1/devices/approvals') {
        approvalReads += 1;
        assert.equal(init.method ?? 'GET', 'GET', 'pending phone approvals are read-only');
        assert.equal(init.credentials, 'same-origin', 'the approvals request carries the signed-in phone session');
        return reply({ version: 1, links: [] });
      }
      if (url.pathname === '/api/v1/boards/' + board + '/state') { snapshotReads += 1; return reply({ version: 1, state: { sequence: 0, sealed } }, 200, { etag: '"0"' }); }
      if (url.pathname === '/api/v1/boards/' + board + '/events' && accept === 'text/event-stream') {
        return new Promise((resolveStream, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      }
      if (url.pathname === '/api/v1/boards/' + board + '/events') return reply({ version: 1, events: [] });
      unexpected.push(url.pathname);
      return reply({ version: 1, error: { code: 'NOT_FOUND', message: 'This fixture relay has no such route.' } }, 404);
    },
  };
  const saved = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    events.dispatchEvent(new Event('pagehide'));
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { location, refused, unexpected, replaced, snapshotReads: () => snapshotReads, approvalReads: () => approvalReads };
}

test('[H5,H15] an early pairing survives until the transport takes it when storage refuses writes', async (t) => {
  const board = '0123456789abcdef0123456789abcdef';
  const key = await generateBoardKey();
  const snapshot = { version: 1, tables: { board_meta: [{ meta_key: 'board_id', meta_value: board }], item: [], agent: [], event: [], shout: [], verdict: [] } };
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(snapshot)), { boardId: board, kind: 'snapshot', sequence: 0 })).toString('base64url');
  const page = refusingStoragePage(t, { hash: '#board=' + board + '&key=' + encodeBoardKey(key), board, sealed });
  const { rememberPairing, createTransport } = await servedRelayClient(t);

  assert.equal(rememberPairing()?.board, board, 'the page reads its pairing link at start, before any transport exists');
  assert.equal(page.location.hash === '', true, 'reading the link strips its fragment from the address bar');
  assert.equal(page.refused.includes('pullboard.relay.pair.v1'), true, 'the browser refused to keep the pairing in session storage');

  const transport = await createTransport();
  assert.deepEqual((await transport.request('/api/v1/boards')).boards.map(row => row.id), [board], 'the transport takes the early pairing from module memory and pairs the board');
  assert.equal(page.snapshotReads(), 1, 'the board pairs once');
  assert.ok(page.approvalReads() > 0, 'the transport checks pending approvals with its signed-in session');

  const later = await createTransport();
  assert.deepEqual((await later.request('/api/v1/boards')).boards, [], 'a second take finds no pairing');
  assert.equal(page.snapshotReads(), 1, 'a second transport does not pair the board again');
  assert.equal(page.location.hash === '', true, 'the address bar still has no pairing fragment');

  page.location.hash = '#device=' + 'A'.repeat(22) + '.' + 'B'.repeat(43);
  assert.throws(() => rememberPairing(), error => error.code === 'DEVICE_STORAGE', 'device pairing still refuses storage that cannot keep its code');
  assert.deepEqual(page.unexpected, [], 'the transport used only the fixture relay routes');
  assert.deepEqual(page.replaced, [], 'the page never lost relay access');
});
