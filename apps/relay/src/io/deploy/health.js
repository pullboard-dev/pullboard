/** The relay readiness probe: build version and highest snapshot API version [C7]. */
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fileSystem = fileSystemAdapter();

/** The highest sealed snapshot transport the relay serves (journal.js saveSnapshot accepts 1 and 2). */
export const RELAY_SNAPSHOT_API_HIGHEST = 2;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/** Read the build version the image was cut from; why: a deploy can be checked against its release tag. */
export function relayBuildVersion() {
  return JSON.parse(fileSystem.readFile(join(ROOT, 'package.json'), 'utf8')).version;
}

/** Answer GET /health with ok, version and the highest snapshot API; never storage or configuration. */
export function health(req, res) {
  if (req.method !== 'GET' || new URL(req.url, 'http://localhost').pathname !== '/health') return false;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, version: relayBuildVersion(), snapshotApi: RELAY_SNAPSHOT_API_HIGHEST }) + '\n');
  return true;
}
