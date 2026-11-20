/** A test fixture that starts and stops the resident board process of an e2e board [C7,#10936]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { waitForState } from './check-baseline.js';
import { PULLBOARD_ENTRY } from '../../src/io/resident/client.js';
import { codeVersion } from '../../src/io/resident/client.js';
import { residentPoolSize } from '../../src/io/resident/client.js';
import { residentSocket } from '../../src/io/resident/client.js';
import { startResident } from '../../src/io/resident/client.js';

/** Start the resident board process of `box` in slot 0, through the start path submit's preflight uses, and wait for its pid file. */
export async function startFixtureResident(box, env = process.env) {
  const place = residentSocket(box.repo, PULLBOARD_ENTRY, 0);
  await startResident(place, PULLBOARD_ENTRY, codeVersion(PULLBOARD_ENTRY).version, { ...env });
  await waitForState(() => existsSync(place.pid), 'the resident process listens');
  return place;
}

/** Stop every resident board process this board started, so the sandbox can be removed. */
export function stopFixtureResidents(repo) {
  for (let slot = 0; slot < residentPoolSize({}); slot += 1) {
    const place = residentSocket(repo, PULLBOARD_ENTRY, slot);
    if (!place) continue;
    try { process.kill(Number(readFileSync(place.pid, 'utf8').trim()), 'SIGKILL'); } catch { /* None started, or it already exited. */ }
  }
}
