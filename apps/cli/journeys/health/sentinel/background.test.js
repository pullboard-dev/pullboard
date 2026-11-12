/** The real detached view owns the health observer and drains its exact child [A6,H16]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fetchFresh } from '../../../tests/fixtures/http.js';
import { takeDefaultViewPort } from '../../../tests/fixtures/view/port.js';

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

import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../../packages/doctrine/index.js';
import {
  frozenCriterion,
  loadSpec,
} from '../../../../../packages/spec/index.js';

/** Exercise the real detached worker's callback without advancing or replacing its native cadence. */
test('the actual background sentinel scans once, honors off switches and drains its child [A6,H16]', { timeout: 60_000 }, async t => { // budget: private worker startup, explicit callback probes and graceful owned shutdown, not a latency target.
  const { box, repo, port } = await backgroundBox(t, 'sentinel-integration');
  const probe = join(box.dir, 'sentinel-probe.mjs'), log = join(box.dir, 'sentinel-probe.jsonl');
  const hold = join(box.dir, 'hold-next-sentinel');
  writeFileSync(probe, [
    "import { appendFileSync, existsSync } from 'node:fs';",
    `const log=${JSON.stringify(log)},hold=${JSON.stringify(hold)};`,
    "const record=event=>appendFileSync(log,JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv,uid:process.getuid?.(),...event})+String.fromCharCode(10));",
    "record({kind:'loaded'});let tick;const timers=new Map(),every=setInterval,cancel=clearInterval;",
    "globalThis.setInterval=(callback,ms,...args)=>{const timer=every(callback,ms,...args);if(ms===600000){tick=callback;timers.set(timer,ms);record({kind:'sentinel-interval',ms});}return timer;};",
    "globalThis.clearInterval=timer=>{if(timers.has(timer))record({kind:'sentinel-cancel',ms:timers.get(timer)});return cancel(timer);};",
    "if(process.argv.includes('view'))process.on('SIGUSR2',async()=>{record({kind:'explicit-tick-start'});try{if(!tick)throw new Error('No sentinel callback');await tick();record({kind:'explicit-tick-finished'});}catch(error){record({kind:'explicit-tick-failed',error:error.message});}});",
    "if(process.argv.includes('sentinel')&&process.argv.includes('run')&&existsSync(hold)){record({kind:'held-sentinel'});await new Promise(done=>setTimeout(done,60000));}", // budget: a test-only hold before CLI execution, terminated by the observer's owned shutdown.
  ].join('\n'));
  box.env.NODE_OPTIONS = `${box.env.NODE_OPTIONS ?? ''} --import=${probe}`.trim();
  const init = await box.runLocal(repo, 'init');
  assert.equal(init.code, 0, init.err || init.out);
  const worker = sessionRecord(box, port);
  t.after(() => stopView(worker.pid));
  const observations = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const workerEvents = kind => observations().filter(row => row.pid === worker.pid && row.kind === kind);
  assert.equal((await answers(port, worker.secret))?.status, 200);
  assert.equal(workerEvents('sentinel-interval').length, 1, 'the real worker installs exactly one native ten-minute timer');
  assert.equal(workerEvents('sentinel-interval')[0].ms, 600_000);
  assert.equal(workerEvents('loaded')[0].cwd, box.env.PULLBOARD_HOME, 'the actual detached worker uses this private machine home');
  assert.equal(workerEvents('loaded')[0].uid, process.getuid?.());
  /** A bounded fixture condition, with failures named rather than hidden behind a sleep. */
  const until = async (predicate, message) => {
    const deadline = Date.now() + 20_000; // budget: hang ceiling for one explicit private worker callback, never a throughput assertion.
    while (!predicate() && Date.now() < deadline) await new Promise(done => setTimeout(done, 25)); // budget: poll one owned fixture callback.
    assert.ok(predicate(), message);
  };
  /** Signal only the exact worker this fixture owns; its preloader invokes the already registered callback. */
  const tick = async () => {
    const count = workerEvents('explicit-tick-finished').length;
    assert.ok(alive(worker.pid));
    process.kill(worker.pid, 'SIGUSR2');
    await until(() => workerEvents('explicit-tick-finished').length === count + 1 || workerEvents('explicit-tick-failed').length,
      'the real worker completes its explicit callback');
    assert.deepEqual(workerEvents('explicit-tick-failed'), []);
  };
  const configFile = join(repo, 'pullboard.json'), config = loadConfig(repo);
  const boardFile = join(repo, '.git/pullboard/board.sqlite');
  const expiredClock = { now: () => new Date(Date.now() - 3_600_000 - 60_000) };
  const active = openBoard(boardFile);
  const lane = Object.keys(config.lanes)[0];
  const builderPath = join(box.dir, 'sentinel-builder');
  mkdirSync(builderPath);
  const builder = store.register(active, { lane, path: builderPath });
  const id = store.addItem(active, { by: 'coordinator', lane, title: 'A real background finding', criterion: 'The private board remains readable.' });
  const board = openBoard(boardFile, expiredClock);
  store.claim(board, id, { agentId: builder, lane, leaseMs: 3_600_000,
    freeze: item => frozenCriterion(loadSpec(repo, config), item, loadDoctrine(repo, config)) });
  store.closeBoard(board);
  // Keep this real seat active after its lease lapses so the scheduled sweep observes rather than releases it.
  assert.equal(store.heartbeatSeat(active, builder), true);
  store.shout(active, { from: builder, to: 'coordinator', text: 'The fixture builder is active.', lanes: [lane] });
  /** Read the persisted result through the board reader; the worker alone executes the observer move. */
  const receipts = () => {
    const db = store.openBoardReadOnly(boardFile);
    try { return { notices: db.prepare("SELECT shout_from,shout_to,shout_text FROM shout WHERE shout_from='sentinel' ORDER BY shout_id").all(),
      scans: db.prepare("SELECT event_detail FROM event WHERE event_kind='health-scan' ORDER BY event_id").all(),
      item: db.prepare('SELECT item_status,item_owner FROM item WHERE item_id=?').get(id) }; }
    finally { db.close(); }
  };
  const rawConfig = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...rawConfig, health: { ...(rawConfig.health ?? {}), sentinel: false } }));
  await tick(); assert.equal(receipts().notices.length, 0, 'the board off switch prevents a real child scan');
  writeFileSync(configFile, JSON.stringify(rawConfig));
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ ...settings, health: { sentinel: false } }));
  await tick(); assert.equal(receipts().notices.length, 0, 'the machine off switch prevents a real child scan');
  writeFileSync(settingsFile, JSON.stringify(settings));
  await tick();
  const scans = observations().filter(row => row.kind === 'loaded' && row.argv.includes('sentinel') && row.argv.includes('run'));
  assert.equal(scans.length, 1, 'one real CLI child performs the enabled scan');
  assert.ok(scans[0].argv.includes('--health-only'), 'the observer explicitly excludes approved board watches');
  const first = receipts();
  assert.equal(first.notices.length, 2, `the actual worker child scans the real board and publishes its finding: ${JSON.stringify(first.notices)}`);
  assert.deepEqual(first.notices.map(row => row.shout_to).sort(), ['coordinator', builder].sort());
  assert.equal(first.scans.length, 1);
  assert.ok(first.notices.every(row => row.shout_text.includes('CLAIM_LAPSED')));
  assert.deepEqual({ ...first.item }, { item_status: 'claimed', item_owner: builder });
  await tick(); assert.equal(receipts().notices.length, 2, 'a persisting finding posts nothing again');
  const renewed = active;
  store.claim(renewed, id, { agentId: builder, lane, leaseMs: 3_600_000, freeze: item => frozenCriterion(loadSpec(repo, config), item, loadDoctrine(repo, config)) });
  store.release(renewed, id, builder, 'Return the background sentinel fixture claim.', 'OTHER'); store.closeBoard(renewed);
  await tick();
  assert.equal(receipts().notices.filter(row => row.shout_text.startsWith('Resolved:')).length, 2);
  writeFileSync(hold, 'hold the next owned child before CLI execution');
  process.kill(worker.pid, 'SIGUSR2');
  await until(() => observations().some(row => row.kind === 'held-sentinel'), 'the observer has one actual owned child in flight');
  const child = observations().find(row => row.kind === 'held-sentinel');
  assert.equal(child.cwd, repo);
  assert.equal(child.uid, process.getuid?.());
  assert.ok(alive(child.pid));
  await stopView(worker.pid);
  await until(() => !alive(child.pid), 'view shutdown drains the exact active sentinel child');
  assert.equal(workerEvents('sentinel-cancel').length, 1, 'view close cancels its one timer');
  console.log('BACKGROUND_SENTINEL_PROOF', JSON.stringify({ workerPid: worker.pid, childPid: child.pid, timers: 1,
    intervalMs: 600_000, explicitCallbackInvocations: workerEvents('explicit-tick-start').length,
    notices: 4, ownedChildDrained: true, scope: 'actual init/detached worker and child sentinel run; native schedule unchanged; no elapsed ten-minute claim' }));
});
