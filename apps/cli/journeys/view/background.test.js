/** init and resume keep pullboard view running in the background for pullboard.dev [H5,N26]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { takeDefaultViewPort } from '../../tests/fixtures/view/port.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * A fresh repository in a private home whose default view port is a leased stand-in for 4890, so
 * the person's real view is never touched, with the test runner's background opt-out removed.
 */
async function backgroundBox(t, name) {
  const box = e2e.sandbox();
  const lease = await takeDefaultViewPort(box.dir, { agent: `background-view-${name}-${process.pid}` });
  // After-hooks run in order: stop any view this home's record names first, even one a failing
  // assertion never reached, then free the port.
  t.after(() => stopRecordedView(box, lease.port));
  t.after(() => lease.release());
  box.env.PULLBOARD_VIEW_PORT = String(lease.port);
  delete box.env.PULLBOARD_VIEW_BACKGROUND;
  delete box.env.PULLBOARD_VIEW_FOREGROUND;
  delete box.env.PULLBOARD_VIEW_BACKGROUND_CHILD;
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  return { box, repo, port: lease.port };
}

/** Whether a process id is still alive. */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Stop one view this test started, by its own pid, and wait until it is gone. */
async function stopView(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5_000; // budget: ceiling for the view's graceful close after SIGTERM.
  while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25)); // budget: poll interval while the owned view exits.
  if (alive(pid)) process.kill(pid, 'SIGKILL');
}

/** The pids of view processes on this test's leased port, listed (never killed) from ps. */
function viewProcesses(port) {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return listed.stdout.split('\n')
    .filter((line) => line.includes('pullboard.js view --no-open') && line.includes(`--port ${port}`))
    .map((line) => Number(line.trim().split(/\s+/u)[0]));
}

/** Stop the view this private home's session record names, by that pid, when there is one. */
async function stopRecordedView(box, port) {
  let record;
  try { record = sessionRecord(box, port); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (Number.isInteger(record.pid) && record.pid > 1 && record.pid !== process.pid) await stopView(record.pid);
}

/** The private session record a background view left for this port. */
function sessionRecord(box, port) {
  return JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, `view-${port}.json`), 'utf8'));
}

/** Whether something answers on the leased loopback port. */
async function answers(port, secret) {
  try {
    const response = await fetchFresh(`http://127.0.0.1:${port}/api/v1/boards`, {
      headers: { 'x-pullboard-key': secret ?? 'none' }, redirect: 'manual', signal: AbortSignal.timeout(2_000), // budget: a local listener answers at once.
    });
    const body = response.ok ? await response.json() : (await response.body?.cancel(), null);
    return { status: response.status, body };
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw error;
  }
}

/** The lines of a command's output that speak about the background view. */
function viewLines(out) {
  return out.split('\n').filter((line) => /background view|Pullboard view is running|^Port \d+ is in use/u.test(line));
}

test('init leaves a view running for pullboard.dev [H5,N26]', async (t) => {
  const { box, repo, port } = await backgroundBox(t, 'init-view');
  const init = await box.runLocal(repo, 'init');
  assert.equal(init.code, 0, init.err || init.out);
  const record = sessionRecord(box, port);
  t.after(() => stopView(record.pid));
  assert.ok(alive(record.pid), 'the view is still running after init exited');
  assert.notEqual(record.pid, process.pid);

  const lines = viewLines(init.out);
  assert.equal(lines.length, 1, `init prints one line about the view:\n${init.out}`);
  const log = join(box.env.PULLBOARD_HOME, `view-${port}.log`);
  assert.equal(lines[0], 'Pullboard view is running; open https://app.pullboard.dev to see your board.');
  assert.doesNotMatch(init.out, /\b(?:kill\s+\d+|taskkill\s+\/PID\s+\d+)/iu, 'init does not advise killing the live view');
  assert.ok(!init.out.includes(record.secret), 'the line names where the view is, never its secret');

  const listing = await answers(port, record.secret);
  assert.equal(listing?.status, 200, 'the view answers on the port pullboard.dev reads');
  assert.ok(listing.body.boards.some((board) => board.root === repo || board.path === repo || JSON.stringify(board).includes(repo)),
    `the background view lists the board init just made: ${JSON.stringify(listing.body.boards)}`);

  // Detached: its own process group, so closing init's terminal does not stop it.
  const group = spawnSync('ps', ['-o', 'pgid=', '-p', String(record.pid)], { encoding: 'utf8' }).stdout.trim();
  assert.equal(Number(group), record.pid, 'the view leads its own process group');
  assert.ok(existsSync(log), 'the view has its own log');
  assert.equal(statSync(log).mode & 0o777, 0o600, 'the log is private: it holds the view link');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`^Pullboard view: http://127\\.0\\.0\\.1:${port}/`, 'mu'));
  assert.equal(existsSync(join(repo, '.git', 'pullboard', 'view-bind.json')), false,
    'a background start does not count as the person opening the board');

  // A second init leaves the running view alone.
  const again = await box.runLocal(repo, 'init', '--json');
  assert.equal(again.code, 0, again.err || again.out);
  const view = JSON.parse(again.out).view;
  assert.deepEqual({ state: view.state, pid: view.pid }, { state: 'running', pid: record.pid });
  assert.deepEqual(viewProcesses(port), [record.pid], 'one view process, never a second one');

  await stopView(record.pid);
  assert.deepEqual(viewProcesses(port), [], 'no view process is left behind');
});

test('resume starts the view once and the setting turns it off [H5,N26]', async (t) => {
  const { box, repo, port } = await backgroundBox(t, 'resume-view');
  box.env.PULLBOARD_VIEW_BACKGROUND = '0';
  const init = await box.runLocal(repo, 'init');
  assert.equal(init.code, 0, init.err || init.out);
  assert.deepEqual(viewLines(init.out), [], 'the opt-out is quiet');
  assert.equal(await answers(port), null, 'with the opt-out, init starts no view');
  delete box.env.PULLBOARD_VIEW_BACKGROUND;
  const started = [];
  t.after(async () => { for (const pid of started) await stopView(pid); });

  const first = await box.runLocal(repo, 'resume');
  assert.equal(first.code, 0, first.err || first.out);
  const record = sessionRecord(box, port);
  started.push(record.pid);
  assert.equal(viewLines(first.out).length, 1, `resume says it started the view:\n${first.out}`);
  assert.match(viewLines(first.out)[0], new RegExp(`^Pullboard view is running in the background, so https://app\\.pullboard\\.dev finds .* To stop it: kill ${record.pid};`, 'u'));
  assert.equal((await answers(port, record.secret))?.status, 200);

  const second = await box.runLocal(repo, 'resume', '--json');
  assert.equal(second.code, 0, second.err || second.out);
  const card = JSON.parse(second.out);
  assert.deepEqual({ state: card.view.state, pid: card.view.pid }, { state: 'running', pid: record.pid }, 'a running view is left alone');
  assert.equal(sessionRecord(box, port).pid, record.pid, 'same pid');
  assert.deepEqual(viewProcesses(port), [record.pid], 'one process');
  const quiet = await box.runLocal(repo, 'resume');
  assert.deepEqual(viewLines(quiet.out), [], 'a view already running is not announced at every session start');

  await stopView(record.pid);
  assert.equal(await answers(port), null);
  // The machine setting turns it off for init and resume alike.
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  writeFileSync(settings, `${JSON.stringify({ view: { background: false } })}\n`);
  const off = await box.runLocal(repo, 'resume', '--json');
  assert.equal(off.code, 0, off.err || off.out);
  assert.equal(JSON.parse(off.out).view.state, 'off');
  const offInit = await box.runLocal(repo, 'init');
  assert.equal(offInit.code, 0, offInit.err || offInit.out);
  assert.deepEqual(viewLines(offInit.out), []);
  assert.equal(await answers(port), null, 'with view.background false, neither init nor resume starts it');
  assert.deepEqual(viewProcesses(port), []);
  const shown = await box.runLocal(repo, 'settings');
  assert.match(shown.out, /^view\.background: false/mu, 'pullboard settings shows the setting');

  // A busy port is reported once and fails nothing.
  rmSync(settings);
  const held = createServer();
  await new Promise((done, fail) => { held.once('error', fail); held.listen(port, '127.0.0.1', done); });
  t.after(() => new Promise((done) => held.close(done)));
  const busy = await box.runLocal(repo, 'resume', '--json');
  assert.equal(busy.code, 0, busy.err || busy.out);
  assert.equal(JSON.parse(busy.out).view.state, 'busy');
  const busyText = await box.runLocal(repo, 'resume');
  assert.equal(busyText.code, 0, busyText.err || busyText.out);
  const busyLines = viewLines(busyText.out);
  assert.equal(busyLines.length, 1, `one line for a busy port:\n${busyText.out}`);
  assert.match(busyLines[0], new RegExp(`^Port ${port} is in use.*, so the background view did not start, and pullboard\\.dev looks for your view on that port: stop .+, then run pullboard resume$`, 'u'));
  const busyInit = await box.runLocal(repo, 'init');
  assert.equal(busyInit.code, 0, busyInit.err || busyInit.out);
  assert.equal(viewLines(busyInit.out).length, 1);
  assert.deepEqual(viewProcesses(port), [], 'a busy port starts no view');
});
