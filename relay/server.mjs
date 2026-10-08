/** Production relay entry point for the Railway container [H5,H18]. */
import { createServer } from 'node:http';
import { chmodSync, chownSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAuthHandler } from './auth-http.js';
import { createRelayAuth } from './auth.js';
import { createGitHubClient } from './github.js';
import { createRelayHandler } from './service.js';
import { Refused } from '../src/refused.js';

const NODE_UID = 1000;
const NODE_GID = 1000;

/** Create private relay directories and hand their contents to the unprivileged service user. */
function prepareStorage(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Refused('RELAY_STORAGE', 'mount a private regular volume directory at PULLBOARD_RELAY_DATA and restart the service');
  }
  chmodSync(directory, 0o700);
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      throw new Refused('RELAY_STORAGE', 'remove symlinks from the private relay volume and restart the service');
    }
    if (entry.isDirectory()) prepareStorage(path);
    else if (entry.isFile()) {
      chmodSync(path, 0o600);
      if (process.getuid?.() === 0) chownSync(path, NODE_UID, NODE_GID);
    } else throw new Refused('RELAY_STORAGE', 'keep only regular files and directories in the private relay volume');
  }
  if (process.getuid?.() === 0) chownSync(directory, NODE_UID, NODE_GID);
}

/** Drop the startup privilege after preparing Railway's root-mounted volume. */
function dropPrivileges() {
  if (process.getuid?.() !== 0) return;
  try {
    process.setgroups([]);
    process.setgid(NODE_GID);
    process.setuid(NODE_UID);
  } catch {
    throw new Refused('RELAY_USER', 'start as the image node user, or set RAILWAY_RUN_UID=0 with permission to drop startup privileges');
  }
}

/** Handle the Railway readiness probe without exposing storage or configuration. */
function health(req, res) {
  if (req.method !== 'GET' || new URL(req.url, 'http://localhost').pathname !== '/health') return false;
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('ok\n');
  return true;
}

/** Start the authenticated opaque relay on Railway's assigned port and public origin. */
async function startRelay() {
  const publicOrigin = process.env.PULLBOARD_PUBLIC_ORIGIN || '';
  const data = resolve(process.env.PULLBOARD_RELAY_DATA || '/data');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Refused('RELAY_PORT', 'set PORT to an available TCP port from 1 to 65535 and restart the service');
  }
  const privateKey = (process.env.GITHUB_APP_PRIVATE_KEY || '').replaceAll('\\n', '\n');
  try { prepareStorage(data); }
  catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('RELAY_STORAGE', 'make PULLBOARD_RELAY_DATA writable by the startup user, then restart the service');
  }
  dropPrivileges();
  if (process.getuid?.() === 0) {
    throw new Refused('RELAY_USER', 'start as the image node user, or set RAILWAY_RUN_UID=0 so startup can prepare the volume and drop privileges');
  }
  const auth = createRelayAuth({
    database: join(data, 'auth.sqlite'),
    github: createGitHubClient({
      clientId: process.env.GITHUB_APP_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET || '',
      privateKey,
      callbackURL: callbackURL(publicOrigin),
    }),
  });
  const authHandler = createAuthHandler({ auth, publicOrigin });
  const relayHandler = createRelayHandler({
    directory: join(data, 'boards'),
    backupsDirectory: join(data, 'backups'),
    auth,
    publicOrigin,
  });
  /** Route readiness, GitHub authentication and opaque board relay requests. */
  async function handleRequest(req, res) {
    if (health(req, res)) return;
    if (await authHandler(req, res)) return;
    await relayHandler(req, res);
  }
  const server = createServer(handleRequest);
  server.requestTimeout = 15_000;
  try {
    await new Promise((ready, fail) => {
      server.once('error', fail);
      server.listen(port, '0.0.0.0', ready);
    });
  } catch (error) {
    relayHandler.close();
    auth.close();
    throw new Refused(error?.code === 'EADDRINUSE' ? 'PORT_BUSY' : 'RELAY_LISTEN', 'set Railway PORT to a free listener and restart the relay');
  }
  let closing = false;
  /** Close handlers, connections and SQLite before the container exits. */
  async function stop() {
    if (closing) return;
    closing = true;
    relayHandler.close();
    auth.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}

/** Build the callback URL only from the operator-configured trusted public origin. */
function callbackURL(publicOrigin) {
  try { return new URL('/auth/github/callback', publicOrigin).href; }
  catch { throw new Refused('RELAY_CONFIG', 'set PULLBOARD_PUBLIC_ORIGIN to the relay HTTPS origin and restart the service'); }
}

try {
  await startRelay();
} catch (error) {
  const refusal = error instanceof Refused
    ? error
    : new Refused('RELAY_STARTUP', 'check the relay service variables and volume permissions, then restart it');
  const message = refusal.message.replace(/^\[[^\]]+\] /, '');
  process.stderr.write(`relay startup failed: [${refusal.code}] ${message}\n`);
  process.exitCode = 1;
}
