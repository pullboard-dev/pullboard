/**
 * `pullboard runner local`: the machine's own runner. It serves the board API on loopback for the boards that asked
 * for it and runs runner serve against each, so the gate and landing jobs it takes go through the same claim, renew
 * and receipt calls as a remote runner's [P7]. One runs per machine; `--off` stops it cleanly.
 */
import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { loadavg } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { hostCapabilities } from '../../../../../../packages/drive/index.js';
import { localLoadAdmits } from '../../../../../../packages/drive/index.js';
import { localLoadShare } from '../../../../../../packages/config/index.js';
import { asyncFetchEnabled } from '../../../../../../packages/config/index.js';
import { localBoards } from '../../../../../../packages/drive/index.js';
import { localRunnerState } from '../../../../../../packages/drive/index.js';
import { processAlive } from '../../../../../../packages/drive/index.js';
import { serveLocalRunner } from '../../../../../../packages/drive/index.js';
import { runnerSettingOn } from '../../../../../../packages/drive/index.js';
import { machineSettingsFile } from '../../../../../../packages/resources/light.js';
import { pullGit } from '../git.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { runLandingJob } from '../../../../../../packages/landing/index.js';
import { diagnoseLandingRed } from '../../commands/flakes.js';
import { loopbackBoardApi } from '../../commands/serve.js';
import { BOARD_HOST } from '../local.js';
import { localRunnerFolder } from '../local.js';
import { localRunnerHome } from '../local.js';

// Budget: --off waits up to 30 s for the runner to hand its job back and close; a gate it stopped is retaken by the next puller.
const STOP_WAIT_MS = 30_000;

/**
 * A pulled land job, run in the local runner's landing checkout: merge, check, push trunk by compare-and-swap [P7].
 * Why a static import: this process outlives the checkout that started it, which may be an item folder removed later.
 */
function land(claim, { cache, renew, env }) {
  return runLandingJob(claim.payload, { workdir: join(cache, 'land'), renew, env, diagnose: diagnoseLandingRed, asyncFetch: asyncFetchEnabled() });
}

/** Run the local runner until SIGINT or SIGTERM; refuses LOCAL_RUNNER_RUNNING, a non-zero exit, when a runner of this home already runs. */
async function serveLocal(io) {
  const folder = localRunnerFolder();
  // The log is written as it happens: this process runs for hours and its output is the runner log.
  const say = line => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const stop = new AbortController();
  const stopped = () => stop.abort();
  process.once('SIGINT', stopped); process.once('SIGTERM', stopped);
  try {
    const projects = () => localBoards(folder).map(root => ({ root, name: basename(root), project: basename(root), added: '' }));
    const served = await serveLocalRunner({ folder, open: () => loopbackBoardApi(io, { projects, secret: randomBytes(18).toString('base64url') }),
      wakeOnOffer: runnerSettingOn(machineSettingsFile(), 'runners.localWake'), home: localRunnerHome(), capabilities: [...hostCapabilities(), BOARD_HOST], handlers: { land }, git: pullGit, signal: stop.signal, say,
      admit: ({ running, held }) => localLoadAdmits({ load: loadavg()[0], cores: availableParallelism(), share: localLoadShare(), running, held }) });
    if (!served.served) throw new Refused(served.code, `a local runner of this home already runs${served.pid === null ? '' : ` (pid ${served.pid})`}`, served.next);
    return 0;
  } finally {
    process.off('SIGINT', stopped); process.off('SIGTERM', stopped);
  }
}

/** Stop this machine's local runner and wait until it has handed back its job and exited; the next pull submit starts it again. */
async function stopLocal(io) {
  const state = localRunnerState(localRunnerFolder());
  if (!state) { io.result?.({ stopped: false, running: false }); io.say('no local runner runs on this machine'); return 0; }
  try { process.kill(state.pid, 'SIGTERM'); } catch { /* it exited on its own */ }
  const until = Date.now() + STOP_WAIT_MS;
  while (processAlive(state.pid) && Date.now() < until) await pause(100);
  if (processAlive(state.pid)) throw new Refused('LOCAL_RUNNER_BUSY', `the local runner (pid ${state.pid}) did not stop within ${STOP_WAIT_MS / 1000} s; run pullboard runner local --off again`);
  io.result?.({ stopped: true, pid: state.pid });
  io.say(`stopped the local runner (pid ${state.pid}); the next pull submit starts it again, or set gate.localRunner false to keep it off`);
  return 0;
}

/** Run `pullboard runner local [--off]`. */
export function localRunnerCommand(io, { off = false } = {}) {
  return off ? stopLocal(io) : serveLocal(io);
}
