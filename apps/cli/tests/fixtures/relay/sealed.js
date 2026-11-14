/** Sealed-relay fixture: a real private CLI board, stand-in GitHub sign-in and an ephemeral relay [A4,H7]. */
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createDecipheriv } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { serveRelay } from '../../../../relay/index.js';
import { createRelayHandler } from '../../../../relay/index.js';
import { createRelayAuth } from '../../../../relay/index.js';
import { createGitHubClient } from '../../../../relay/index.js';
import { githubFixture } from '../relay.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';

/** Seal on the test client only; nonce, authentication tag and ciphertext are opaque to the server. */
function seal(key, value, binding) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, bytes, cipher.getAuthTag()]).toString('base64url');
}

/** Open on the test client only, proving that received ciphertext still represents the sent record. */
function unseal(key, value, binding) {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  assert.equal(bytes[0], 1);
  decipher.setAuthTag(bytes.subarray(-16));
  decipher.setAAD(Buffer.from(JSON.stringify(binding)));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(13, -16)), decipher.final()]).toString());
}

/** Keep API1 ciphertext-interception cases on an explicitly historical HTTP router; current cases use real API2. */
async function sealedFixtureRelay(options, legacySnapshots) {
  if (!legacySnapshots) return serveRelay(options);
  const handler = createRelayHandler(options);
  const server = createServer((req, res) => {
    if (/^\/api\/v2(?:\/|$)/u.test(req.url ?? '')) {
      req.resume();
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, error: { code: 'NOT_FOUND', message: 'This historical fixture supports API1.' } }));
      return;
    }
    return handler(req, res);
  });
  await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListening); });
  return { port: server.address().port,
    close: () => new Promise(done => { handler.close(); server.close(done); server.closeAllConnections(); }) };
}

/** Create a real private CLI board, actual stand-in GitHub sign-in, and an ephemeral relay server. */
export async function fixture(t, { machineCredentials = true, legacySnapshots = false, moveBodyBytes } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-sealed-http-')));
  const root = join(directory, 'repo');
  const home = join(directory, 'home');
  const data = join(directory, 'relay');
  const privateBin = join(directory, 'bin');
  mkdirSync(root); mkdirSync(home); mkdirSync(privateBin);
  const env = { ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.PULLBOARD_RELAY_TOKEN;
  const quoteShell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const cliPath = resolve(import.meta.dirname, '../../../pullboard.js');
  const pullboardPath = join(privateBin, 'pullboard');
  writeFileSync(pullboardPath, `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(cliPath)} "$@"\n`);
  chmodSync(pullboardPath, 0o755);
  env.PATH = [privateBin, env.PATH].filter(Boolean).join(delimiter);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  // The coordinator checkout needs a commit on main before any claim can read its committed policy.
  writeFileSync(join(root, 'README.md'), 'private sealed relay fixture project\n');
  runFixtureGit(['add', 'README.md'], { cwd: root, env, encoding: 'utf8' });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture base'], { cwd: root, env, encoding: 'utf8' });
  /** Run the current CLI only in the fixture's private home and Git repository. */
  function cli(...args) {
    const result = runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../pullboard.js'), ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    return result.stdout;
  }
  cli('init');
  runFixtureGit(['add', 'pullboard.json'], { cwd: root, env, encoding: 'utf8' });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'fixture policy'], { cwd: root, env, encoding: 'utf8' });
  const config = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  const marker = 'PRIVATE_BOARD_CRITERION_DO_NOT_RELAY_IN_CLEAR';
  cli('add', Object.keys(config.lanes)[0], 'A sealed board item', '--criterion', marker);
  const document = JSON.parse(cli('export'));
  const id = document.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  const provider = await githubFixture(t);
  const auth = createRelayAuth({ database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config) });
  const flow = auth.beginWeb();
  const redirect = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(redirect.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  await auth.linkBoard(person.token, id, 'fixture/repository');
  const machines = machineCredentials ? await Promise.all([
    auth.issueMachine(person.token, { board: id, machine: 'client-one' }),
    auth.issueMachine(person.token, { board: id, machine: 'client-two' }),
  ]) : [];
  const tokenIssuer = machines[0]?.token ?? person.token;
  const one = await auth.issueToken(tokenIssuer, { board: id, agent: 'client-one' });
  const two = await auth.issueToken(machines[1]?.token ?? tokenIssuer, { board: id, agent: 'client-two' });
  const relay = await sealedFixtureRelay({ directory: data, auth, port: 0, pollMs: 20, publicOrigin: 'http://127.0.0.1:44444', moveBodyBytes }, legacySnapshots);
  t.after(async () => { await relay.close(); auth.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + relay.port;
  const key = randomBytes(32);

  /** Send one private API call without putting credentials or board keys in its URL or diagnostics. */
  async function call(path, { method = 'GET', body, token = one.token, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { 'x-pullboard-engine': String(ENGINE_VERSION), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  /** Bind each client seal to its board, kind and proposed transport position. */
  function clientSeal(value, kind, sequence, board = id) { return seal(key, value, { board, kind, sequence }); }
  /** Unseal received records at their actual committed position, never the client's old proposal. */
  function clientOpen(value, kind, sequence, board = id) { return unseal(key, value, { board, kind, sequence }); }
  return { directory, root, home, env, data, cli, document, id, marker, auth, person, machines, tokenIssuer, one, two, relay, origin, key, call, clientSeal, clientOpen, path: '/api/v1/boards/' + id };
}

