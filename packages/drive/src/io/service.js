/**
 * The program an installed runner service runs: `pullboard runner serve` without the rest of the CLI, so a runner holds
 * only this file and what it imports [P7]. `pullboard runner install-serve` copies them to the runner and starts it as a
 * login service that restarts on exit.
 *
 * Usage: node service.js <board-url> <key-file> <cache-directory>
 */
import { readFileSync } from 'node:fs';
import { serveRunner } from './pull.js';

const [board, keyFile, cache] = process.argv.slice(2);
const stop = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stop.abort());
const say = line => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
try {
  say(`runner serve pulling from ${board}`);
  await serveRunner({ board, key: readFileSync(keyFile, 'utf8').trim(), cache, signal: stop.signal, say });
} catch (error) {
  // An exit is a restart: the service manager starts it again, so a refusal is logged with its code and nothing is lost.
  say(`stopped: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`);
  process.exitCode = 1;
}
