/** Exercise the deploy smoke script against a private loopback relay [H5,H18]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';
import { githubFixture } from './relay-fixture.js';

const SMOKE = resolve(import.meta.dirname, '../relay/smoke.mjs');
const SERVER = resolve(import.meta.dirname, '../relay/server.mjs');
const DOCKERFILE = resolve(import.meta.dirname, '../relay/Dockerfile');
const README = resolve(import.meta.dirname, '../relay/README.md');

/** Extract a documented setting so the checklist can be checked against executable config. */
function setting(text, pattern, description) {
  const match = pattern.exec(text);
  assert.ok(match, `README deployment checklist must state ${description}`);
  return match[1];
}

/** Run the checked-in smoke script in a private real repository without retaining its output. */
function runSmoke(box, address) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [SMOKE, address], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let safeFailure = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => {
      const line = part.split('\n').find((entry) => entry.startsWith('relay smoke failed:'));
      if (line) safeFailure = line;
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('private relay deployment smoke did not complete'));
      if (code !== 0) return resolveResult({ code, failure: safeFailure });
      try { resolveResult({ code, result: JSON.parse(stdout) }); }
      catch { reject(new Error('private relay deployment smoke did not return its safe summary')); }
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
  const previous = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal((await box.cli('relay', 'off')).code, 0);
  const beforeSmoke = box.calls.length;

  const smoke = await runSmoke(box, previous.url);
  assert.equal(smoke.code, 0, smoke.failure);
  const result = smoke.result;
  assert.equal(result.ok, true);
  assert.equal(typeof result.item, 'number');
  assert.equal(result.sequence, 1);
  assert.equal(existsSync(box.linkFile), false, 'relay off forgets the private link metadata');
  assert.equal(existsSync(box.keyFile), false, 'relay off forgets the device-only board key');
  assert.ok(box.calls.slice(beforeSmoke).some((call) => call.method === 'DELETE' && call.path === `/api/v1/boards/${previous.board}`),
    'the smoke sends relay off to the supplied local relay');
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
  const state = await fetch(`${previous.url}/api/v1/boards/${previous.board}/state`, {
    headers: { authorization: `Bearer ${previous.token}` },
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
  const child = spawn(process.execPath, [SERVER], { cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((ready) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); ready(); }, 5000);
      child.once('close', () => { clearTimeout(timer); ready(); });
    });
  });
  await waitHealthy(child, origin);
  assert.equal(child.exitCode, null, 'the long-running relay remains available after its health probe');
});
