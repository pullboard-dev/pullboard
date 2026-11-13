/** A claim whose queued gate is running is active: neither the lapsed-lease sweep nor the idle release takes it [B4,C7,H16]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { openBoard } from '../../../../lib/index.js';
import { captureLapsedClaims } from '../../../../../packages/health/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { maintainStaleState } from '../../../../../packages/store/index.js';
import { staleStateLimits } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { settledGateJob } from '../../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const MINUTE = 60_000;

/** Require authentic command success before reading its JSON document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** The item's pulled gate job as `show --json` prints it ({ id, step, gate }), or null before one is offered. */
function gateJob(box, id) {
  const shown = box.run(box.repo, 'show', String(id), '--json', '--no-next');
  return shown.code === 0 ? JSON.parse(shown.out).gateJob ?? null : null;
}

/** The tail of the fixture machine's local runner log, so a gate that never starts shows what the runner saw. */
function runnerLog(box) {
  const log = join(box.env.PULLBOARD_MACHINE_HOME ?? '', 'local-runner', 'runner.log');
  return existsSync(log) ? readFileSync(log, 'utf8').slice(-2000) : '(no local runner log)';
}

/** Read the real board under an optional injected clock. */
function read(box, id, clock) {
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, clock);
  try { return { item: getItem(board, id), job: gateJob(box, id) }; }
  finally { board.db.close(); }
}

/** A gate that, once armed, runs until the test releases it, so maintenance observes it mid-run. */
function heldGate(box) {
  const script = join(box.dir, 'held-gate.cjs');
  const gate = { mode: join(box.dir, 'hold-gate'), release: join(box.dir, 'release-gate'), started: join(box.dir, 'gate-started') };
  writeFileSync(script, [
    "const fs = require('node:fs');",
    'const [armed, release, started] = process.argv.slice(2);',
    'if (!fs.existsSync(armed)) process.exit(0);',
    "fs.writeFileSync(started, 'start\\n');",
    'const deadline = Date.now() + 180000; // budget: hang ceiling while maintenance observes the running gate.',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    'process.exit(fs.existsSync(release) ? 0 : 23);',
  ].join('\n'));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return { ...gate, command: `${quote(process.execPath)} ${quote(script)} ${quote(gate.mode)} ${quote(gate.release)} ${quote(gate.started)}` };
}

/**
 * A real project with queued submits and a gate held open on demand: the web seat's claim has a queued gate running,
 * and the api seat holds an ordinary claim with no gate.
 */
function fixture(t) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  const gate = heldGate(isolated);
  let box;
  try { box = helpers.project(gate.command, isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')) }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure queued submit [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const api = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/one');
  assert.equal(fixtureJoin(box.run, api, 'api', '--route', 'strong').code, 0);
  box.boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const add = (lane, title, check = 'true') => document(fixtureAdd(box.run, box.repo, lane, title, '--specs', lane === 'api' ? 'G2' : 'G1',
    '--criterion', `${title} passes its gate.`, '--check', check, '--json')).item.item_id;
  // The held command is the item's frozen check: a pulled gate runs the check phase on the runner whatever its proof selects [P7].
  const gated = add('web', 'Build whose gate is running', gate.command), idle = add('api', 'Build with no gate');
  t.after(async () => {
    writeFileSync(gate.release, 'release\n');
    if (gateJob(box, gated)) await settledGateJob(box, gated, { deadlineMs: 120_000 }); // budget: hang ceiling for the local runner to finish the released gate; no elapsed-time assertion.
    if (box.runnerPid) try { process.kill(box.runnerPid, 'SIGKILL'); } catch { /* already gone */ }
    helpers.cleanup();
  });
  return { ...box, helpers, gate, api, gated, idle };
}

/** Capture and apply one maintenance pass at the given clock, as the write path and the sentinel do. */
function maintain(box, clock) {
  const config = loadConfig(box.repo);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(box.boardFile, clock);
  try {
    const snapshot = captureLapsedClaims({ info: { root: box.repo }, clock, config }, board, 'coordinator');
    if (snapshot) maintainStaleState(board, { agentId: 'coordinator', snapshot, health: config.health ?? {}, claimsOnly: true });
    return snapshot?.claims ?? [];
  } finally { board.db.close(); }
}

test('a claim with a running queued gate survives the idle release and the lapsed-lease sweep; one with no gate lapses [B4,C7,H16]', async t => {
  const box = fixture(t);
  document((await box.runLocal(box.api, 'claim', String(box.idle), '--json')));
  const folder = document((await box.runLocal(box.web, 'claim', String(box.gated), '--json'))).itemFolder;
  assert.equal(box.helpers.commitFile(box, folder, 'web/built.js', 'export const built = true;\n', 'feat(web): build it [G1]').status, 0);
  writeFileSync(box.gate.mode, 'hold\n');
  // Spawned directly: the fixture's own submit call waits for the queue to settle, and this gate is held open.
  const submit = await runFixtureChildAsync(process.execPath, [fileURLToPath(new URL('../../../pullboard.js', import.meta.url)), 'submit', String(box.gated), '--no-next', '--json'], { cwd: folder, env: box.env, encoding: 'utf8' });
  const queued = JSON.parse(submit.stdout);
  assert.equal(queued.queued, true, submit.context);
  box.runnerPid = queued.localRunner?.pid;
  const running = () => read(box, box.gated).job?.step === 'running' && existsSync(box.gate.started);
  try { await box.helpers.waitFor(running, 'the queued gate is running', 60000); } // budget: hang ceiling for the local runner to start its gate; no elapsed-time assertion.
  catch (error) { throw new Error(`${error.message}: job ${JSON.stringify(read(box, box.gated).job)}, check started ${existsSync(box.gate.started)}\n${runnerLog(box)}`); }
  const claimed = read(box, box.gated).item, other = read(box, box.idle).item;
  const limit = staleStateLimits(loadConfig(box.repo)).claim;

  // The sentinel's idle release: 45 minutes with no commit or file change, lease still live.
  const idleAt = { now: () => new Date(Date.now() + 45 * MINUTE) };
  assert.ok(idleAt.now().toISOString() < claimed.item_lease_until, 'the idle case keeps a live lease');
  assert.equal(read(box, box.gated).job.step, 'running', JSON.stringify(read(box, box.gated).job));
  const idleRows = maintain(box, idleAt);
  assert.ok(!idleRows.some(row => row.id === box.gated), 'the idle release never selects a claim whose gate is running');
  assert.equal(read(box, box.gated, idleAt).item.item_status, 'claimed');

  // The 2-hour lease sweep: past the lease and its stale interval.
  const lapsedAt = { now: () => new Date(Math.max(Date.parse(claimed.item_lease_until), Date.parse(other.item_lease_until)) + limit + MINUTE) };
  maintain(box, lapsedAt);
  const gated = read(box, box.gated, lapsedAt);
  assert.equal(gated.job.step, 'running', JSON.stringify(gated.job));
  assert.equal(gated.item.item_status, 'claimed', 'the lapsed-lease sweep keeps a claim whose gate is running');
  assert.equal(gated.item.item_owner, claimed.item_owner);
  assert.equal(read(box, box.idle, lapsedAt).item.item_status, 'open', 'a claim with no gate still lapses');
});
