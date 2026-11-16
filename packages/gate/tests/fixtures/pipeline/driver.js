/**
 * Repro, #3836 (8 Nov): a gate driver whose event loop was blocked stopped renewing its lease while it lived, and 25
 * healthy gates an hour were ended SUBMIT_HANDOFF_DEAD. The invariant: a sweeper in another process never declares a
 * live, same-incarnation driver dead for a lapsed lease alone, and still declares it dead once the process is gone
 * [C7]. Fails on 515d062720^; passes after it.
 */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  from,
  gone,
  guardProcesses,
  hopCheck,
  scratch,
  waitUntil,
  within,
} from './kit.js';

const drive = await from('packages/drive/index.js');
const { exactStart } = await from('packages/gate/index.js');
const { withFixtureBoard } = await from('packages/board/tests/fixtures/board.js');

/** How far past its lease the blocked driver is judged: three minutes, past the 2-minute lease. */
const LAPSED_MS = 3 * 60_000;

guardProcesses();

/**
 * Judge the driver the way the hand-off sweep does, from a separate process reading the real board file.
 *
 * @param {string} boardFile
 * @param {string} handoff
 * @returns {{ lapsed: boolean, dead: boolean, ms: number }}
 */
function sweeperVerdict(boardFile, handoff) {
  const source = `
    import { readGateDrive, gateDriverGone } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/drive/index.js')).href)};
    import { deadWorker } from ${JSON.stringify(pathToFileURL(join(ROOT, 'apps/cli/src/io/alive.js')).href)};
    import { withFixtureBoard } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/board/tests/fixtures/board.js')).href)};
    const started = performance.now();
    const record = withFixtureBoard(${JSON.stringify(boardFile)}, board => readGateDrive(board.db, ${JSON.stringify(handoff)}));
    const verdict = { lapsed: gateDriverGone(record, Date.now()), dead: deadWorker(record, { id: ${JSON.stringify(handoff)} }) };
    process.stdout.write(JSON.stringify({ ...verdict, ms: performance.now() - started }));`;
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('a live driver with a lapsed lease is never declared dead; the same driver gone is [C7]', { timeout: 60_000 }, async () => {
  const dir = await scratch('live-driver');
  const boardFile = join(dir, 'board.sqlite');
  const handoff = '7a1b2c3d-0000-4000-8000-000000000001';
  const owner = 'driver-hop-live';
  const driver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', cwd: dir, env: { PATH: process.env.PATH, HOP_SCRATCH: dir } });
  await new Promise(resolveSpawn => driver.once('spawn', resolveSpawn));
  const lapsedAt = Date.now() - LAPSED_MS;
  withFixtureBoard(boardFile, board => {
    drive.admitGateDrive(board.db, handoff, { owner, now: lapsedAt });
    drive.recordGateDriveSpawn(board.db, handoff, { owner, pid: driver.pid, started: exactStart(driver.pid), now: lapsedAt });
  });

  await hopCheck('live-driver', async () => {
    const alive = sweeperVerdict(boardFile, handoff);
    assert.equal(alive.lapsed, true, 'the driver\'s lease lapsed 3 minutes ago, as a blocked event loop leaves it');
    const measured = { ms: alive.ms, measured: `lease lapsed ${LAPSED_MS / 60_000} min, process alive: judged ${alive.dead ? 'dead' : 'alive'}` };
    within(alive.dead === false, 'a sweeper never declares a live, same-incarnation driver dead for a lapsed lease', measured);
    driver.kill('SIGKILL');
    await waitUntil(() => gone(driver.pid), 'the driver process exits', 10_000, 50);
    const after = sweeperVerdict(boardFile, handoff);
    assert.equal(after.dead, true, 'the same driver, once its process is gone, is dead');
    return { ...measured, measured: `${measured.measured}; after kill: judged dead` };
  });
});
