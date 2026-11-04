/** Real board, ordered replay and background lifetime controls for the health sentinel [A6,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CALLER_SESSION_NAMES, checkoutSessionFile, withoutCallerSession } from '../src/agent-session.js';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { loadDoctrine } from '../src/doctrine.js';
import { applyRelayMove, appliedSequence, prepareEngineMove } from '../src/engine.js';
import { exportBoard } from '../src/exchange.js';
import { HEALTH_SENTINEL_ENGINE } from '../src/health-receipts.js';
import { scanHealthSentinel } from '../src/health-sentinel.js';
import { repoInfo } from '../src/git.js';
import { agentSessionDigest } from '../src/person.js';
import { eventCauses, rigorReport } from '../src/rigor.js';
import { refreshBoard, startServeSentinel, HEALTH_SENTINEL_INTERVAL_MS } from '../src/serve-sentinel.js';
import { machineSettingsFile } from '../src/settings.js';
import { frozenCriterion, loadSpec } from '../src/spec.js';
import { runFixtureGit } from './fixture-child.js';

const HOUR = 3_600_000;

/** Isolate the board, Git and machine home; test time is elapsed wall time plus an explicit offset. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-health-sentinel-')));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const overrides = { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Sentinel Fixture', GIT_AUTHOR_EMAIL: 'sentinel@example.invalid',
    GIT_COMMITTER_NAME: 'Sentinel Fixture', GIT_COMMITTER_EMAIL: 'sentinel@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Fixture\n\n## A\n- A6 [approved, must] Report stuck work. | gate: review\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Fixture rules\n\n## PB\n- PB1 [approved, must] Keep the fixture isolated. | gate: review\n');
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', 'chore: initialize sentinel fixture [A6]'], { cwd: root, env });
  const settings = machineSettingsFile();
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false } }));
  const clock = { offset: 0, now() { return new Date(Date.now() + this.offset); } };
  const file = join(root, '.git/pullboard/board.sqlite');
  const board = store.openBoard(file, clock);
  store.register(board, { lane: 'coordinator', path: root });
  // Seats join as a test first uses them, so no test carries an idle seat it never meant to have.
  const builders = [];
  const seat = index => (builders[index] ??= store.register(board, { lane: 'core', path: join(directory, `core-${index + 1}`) }));
  const config = loadConfig(root);
  const freeze = item => frozenCriterion(loadSpec(root, config), item, loadDoctrine(root, config));
  /** Make a genuine claim whose expiry the injected offset can advance past. */
  const claimed = index => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: `Stuck fixture ${index}`, specIds: ['A6'], criterion: 'The fixture remains readable.' });
    store.claim(board, id, { agentId: seat(index), lane: 'core', leaseMs: HOUR, freeze });
    return id;
  };
  /** Read the real health snapshot and apply it through authenticated, versioned replay. */
  const scan = () => {
    const observation = scanHealthSentinel(file, { root, config: loadConfig(root), now: clock.now() });
    if (!observation) return null;
    const move = prepareEngineMove(board, 'recordHealthFindings', [{ agentId: 'coordinator', ...observation }], { actor: 'coordinator' });
    const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString(), kind: 'move',
      sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result.result;
  };
  t.after(() => {
    store.closeBoard(board); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { root, file, board, builders, seat, clock, claimed, scan, freeze, config, settings };
}

test('a new stuck finding reaches the coordinator and owner once [A6]', t => {
  const box = fixture(t);
  const id = box.claimed(0);
  box.clock.offset += 2 * HOUR;
  const originalObservation = scanHealthSentinel(box.file, { root: box.root, config: box.config, now: box.clock.now() });
  const rawClaim = box.board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id = ?').get(id);
  assert.deepEqual(box.scan().added, [`CLAIM_LAPSED:item:${id}`]);
  const notices = store.allShouts(box.board);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map(notice => notice.shout_to).sort(), ['coordinator', box.builders[0]].sort());
  for (const notice of notices) {
    assert.equal(notice.shout_from, 'sentinel');
    assert.match(notice.shout_text, /CLAIM_LAPSED/u);
    assert.ok(notice.shout_text.includes(box.builders[0]), 'the complete owner address stays in the notice');
    assert.ok(notice.shout_text.includes(`pullboard claim ${id}`));
  }
  assert.deepEqual(box.board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id = ?').get(id), rawClaim,
    'a health observation does not change claim state');
  const before = exportBoard(box.board);
  assert.deepEqual(store.recordHealthFindings(box.board, { agentId: 'coordinator', findings: originalObservation.findings,
    observedRevision: store.events(box.board).at(-1).event_id }), { added: [], resolved: [] }, 'the board also deduplicates an already observed episode');
  assert.deepEqual(exportBoard(box.board), before, 'a second observer cannot duplicate the episode');
  for (let index = 0; index < 3; index += 1) assert.equal(box.scan(), null);
  assert.deepEqual(exportBoard(box.board), before, 'persisting findings create no repeated events or shouts');
  store.claim(box.board, id, { agentId: box.builders[0], lane: 'core', leaseMs: HOUR, freeze: box.freeze });
  store.release(box.board, id, box.builders[0]);
  assert.deepEqual(box.scan().resolved, [`CLAIM_LAPSED:item:${id}`]);
  assert.equal(store.allShouts(box.board).filter(notice => notice.shout_text.startsWith('Resolved:')).length, 2,
    'one resolution reaches each reader');
  assert.equal(box.scan(), null);
  assert.equal(store.events(box.board).filter(event => event.event_kind === 'health-failure').length, 1);
  assert.equal(store.events(box.board).filter(event => event.event_kind === 'health-resolved').length, 1);
});

test('an idle seat beside work it could take is noticed once and resolves when it takes work [A6,N2]', t => {
  const box = fixture(t);
  const id = box.claimed(0);
  const idle = box.seat(1);
  box.clock.offset += 2 * HOUR;
  // The idle seat's agent is around (it shouted just now) but holds and pulls nothing (#940).
  store.shout(box.board, { from: idle, to: 'coordinator', text: 'still here', lanes: ['core'] });
  const idleKey = `IDLE_AGENT:agent:${idle}`;
  assert.deepEqual(box.scan().added.sort(), [`CLAIM_LAPSED:item:${id}`, idleKey].sort());
  const idleNotices = store.allShouts(box.board).filter(notice => notice.shout_text.includes('IDLE_AGENT'));
  assert.deepEqual(idleNotices.map(notice => notice.shout_to), [idle], 'the idle seat alone hears it, once (#940); the coordinator sees it in pullboard health');
  const before = exportBoard(box.board);
  for (let index = 0; index < 3; index += 1) assert.equal(box.scan(), null);
  assert.deepEqual(exportBoard(box.board), before, 'a persisting idle seat creates no repeated events or shouts');
  store.claim(box.board, id, { agentId: idle, lane: 'core', leaseMs: HOUR, freeze: box.freeze });
  assert.ok(box.scan().resolved.includes(idleKey), 'taking the work resolves the idle finding');
  assert.equal(box.scan(), null);
  assert.equal(store.events(box.board).filter(event => event.event_kind === 'health-failure' && JSON.stringify(event).includes(idleKey)).length, 1);
});

test('a stuck cause that recurs is noticed by rigor [A6,D1]', t => {
  const box = fixture(t);
  for (let index = 0; index < 3; index += 1) box.claimed(index);
  box.clock.offset += 2 * HOUR;
  assert.equal(box.scan().added.length, 3);
  const report = rigorReport(store.events(box.board), { person: store.PERSON });
  assert.equal(report.uncaused, 0);
  assert.equal(report.causes.length, 1);
  assert.equal(report.causes[0].key, 'refusal:CLAIM_LAPSED');
  assert.equal(report.causes[0].occurrences, 3);
  assert.equal(report.causes[0].items.length, 3);
  assert.deepEqual(report.causes[0].items.map(item => item.commits), [[], [], []], 'work receipts invent no code commit');
  box.scan();
  assert.deepEqual(rigorReport(store.events(box.board), { person: store.PERSON }), report);
});

test('sentinel replay refuses older engines and stale observations without a false notice [A6,H16]', t => {
  const box = fixture(t);
  box.claimed(0); box.clock.offset += 2 * HOUR;
  const observation = scanHealthSentinel(box.file, { root: box.root, config: box.config, now: box.clock.now() });
  const move = prepareEngineMove(box.board, 'recordHealthFindings', [{ agentId: 'coordinator', ...observation }], { actor: 'coordinator' });
  const receipt = { sequence: 1, at: box.clock.now().toISOString(), kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } };
  const before = exportBoard(box.board);
  assert.throws(() => applyRelayMove(box.board, { ...move, engine: HEALTH_SENTINEL_ENGINE - 1 }, receipt), error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(box.board), before);
  store.shout(box.board, { from: 'coordinator', to: box.builders[0], text: 'A concurrent board change', lanes: ['core'] });
  const eventCount = store.events(box.board).length;
  const refused = applyRelayMove(box.board, move, receipt);
  assert.equal(refused.error.code, 'HEALTH_SCAN_STALE');
  assert.equal(appliedSequence(box.board), 1, 'an ordinary current-engine refusal retains its receipt and advances its prefix');
  assert.equal(store.events(box.board).length, eventCount);
  assert.equal(store.allShouts(box.board).filter(notice => notice.shout_from === 'sentinel').length, 0);
  assert.equal(box.scan().added.length, 1, 'a fresh observation succeeds after the stale one');
});

test('a recurring health episode needs no changed code commit and legacy lookalikes are ignored [A6,H16]', t => {
  const box = fixture(t);
  const id = box.claimed(0);
  box.clock.offset += 2 * HOUR; box.scan();
  store.claim(box.board, id, { agentId: box.builders[0], lane: 'core', leaseMs: HOUR, freeze: box.freeze });
  store.release(box.board, id, box.builders[0]); box.scan();
  store.claim(box.board, id, { agentId: box.builders[0], lane: 'core', leaseMs: HOUR, freeze: box.freeze });
  box.clock.offset += 2 * HOUR; box.scan();
  const report = rigorReport(store.events(box.board), { person: store.PERSON });
  assert.equal(report.causes[0].key, 'refusal:CLAIM_LAPSED');
  assert.equal(report.causes[0].occurrences, 2);
  assert.deepEqual(report.causes[0].items, [{ id, commits: [] }]);
  const event = store.events(box.board).find(value => value.event_kind === 'health-failure');
  const old = { ...event, event_detail: JSON.stringify({ ...JSON.parse(event.event_detail), engine: HEALTH_SENTINEL_ENGINE - 1 }) };
  assert.deepEqual(eventCauses(old), []);
  assert.deepEqual(eventCauses({ ...event, event_by: 'coordinator' }), []);
  assert.deepEqual(eventCauses({ ...event, event_kind: 'shout' }), []);
});

test('resume reads recorded health and scheduled runs refresh it with both off switches intact [A6]', async t => {
  const box = fixture(t);
  const first = box.claimed(0); box.clock.offset += 2 * HOUR;
  box.scan();
  const last = store.events(box.board).filter(event => event.event_kind === 'health-scan').at(-1);
  assert.ok(last, 'the actual ordered scan records findings before resume');
  const notices = store.allShouts(box.board).filter(notice => notice.shout_from === 'sentinel').length;
  const second = box.claimed(1); box.clock.offset += 2 * HOUR;
  let stdout = ''; let stderr = '';
  const code = await main(['resume', '--json'], { cwd: box.root, clock: box.clock,
    stdout: { isTTY: false, write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  assert.equal(code, 0, stderr);
  const resumed = JSON.parse(stdout);
  assert.equal(resumed.health.recordedAt, last.event_at);
  assert.ok(resumed.health.findings.some(finding => finding.item === first));
  assert.equal(resumed.health.findings.some(finding => finding.item === second), false, 'resume does not silently refresh stale recorded findings');
  assert.equal(store.events(box.board).filter(event => event.event_kind === 'health-scan').at(-1).event_id, last.event_id);
  assert.equal(store.allShouts(box.board).filter(notice => notice.shout_from === 'sentinel').length, notices);
  stdout = ''; stderr = '';
  const ran = await main(['sentinel', 'run', '--json'], { cwd: box.root, clock: box.clock,
    stdout: { isTTY: false, write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  assert.equal(ran, 0, stderr);
  const refreshed = JSON.parse(stdout);
  assert.deepEqual(refreshed.sentinels, [], 'health refresh still runs when no approved watch is due');
  assert.ok(refreshed.health.findings.some(finding => finding.item === second));
  const refreshedEvent = store.events(box.board).filter(event => event.event_kind === 'health-scan').at(-1);
  assert.equal(refreshed.health.recordedAt, refreshedEvent.event_at);
  assert.notEqual(refreshed.health.recordedAt, last.event_at);
  assert.ok(store.allShouts(box.board).filter(notice => notice.shout_from === 'sentinel').length > notices, 'scheduled refresh retains ordinary owner alerts');
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify({ ...config, health: { sentinel: false } }));
  assert.equal(scanHealthSentinel(box.file, { root: box.root, config: loadConfig(box.root), now: box.clock.now() }), null);
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(box.settings, JSON.stringify({ health: { sentinel: false }, view: { background: false } }));
  assert.equal(scanHealthSentinel(box.file, { root: box.root, config: loadConfig(box.root), now: box.clock.now() }), null);
});

test('the background sentinel uses the ten minute cadence, skips overlaps and drains on close [A6]', async () => {
  let tick; let interval; let cancelled = false; let release;
  const entered = []; const aborted = [];
  const observer = startServeSentinel({ projects: () => [{ root: '/one' }, { root: '/one' }, { root: '/two' }], enabled: () => true,
    every: (callback, ms) => { tick = callback; interval = ms; return { unref() {} }; }, cancel: () => { cancelled = true; },
    run: (root, signal) => new Promise(resolve => {
      entered.push(root); release = resolve;
      signal.addEventListener('abort', () => { aborted.push(root); resolve(); }, { once: true });
    }) });
  assert.equal(interval, HEALTH_SENTINEL_INTERVAL_MS);
  assert.equal(interval, 600_000);
  const pending = tick(); await Promise.resolve();
  assert.equal(tick(), pending);
  assert.deepEqual(entered, ['/one']);
  await observer.close();
  assert.equal(cancelled, true);
  assert.deepEqual(aborted, ['/one']);
  assert.deepEqual(entered, ['/one'], 'shutdown never starts another project');
  assert.equal(tick(), null);
  release();
});

test('the view-spawned health scan carries no agent session, so a checkout a later session took over never refuses it [A6]', async t => {
  const box = fixture(t);
  const launcher = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'view-launcher' };
  const original = Object.fromEntries(Object.keys(launcher).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  // The same agent's later session took the main checkout over, as pullboard takeover records it.
  const later = agentSessionDigest({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'later-coordinator' });
  writeFileSync(checkoutSessionFile(repoInfo(box.root)), JSON.stringify({ version: 1, agent: 'coordinator', digest: later, at: new Date().toISOString() }) + '\n');
  const run = async () => {
    let stdout = ''; let stderr = '';
    const code = await main(['sentinel', 'run', '--health-only', '--json'], { cwd: box.root, clock: box.clock,
      stdout: { isTTY: false, write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    return { code, stdout, stderr };
  };
  Object.assign(process.env, launcher);
  const stale = await run();
  assert.notEqual(stale.code, 0, 'control: the launching shell’s own session is refused by the taken-over checkout');
  assert.match(stale.stdout + stale.stderr, /NOT_YOUR_CHECKOUT/);
  const { EventEmitter } = await import('node:events');
  let spawned;
  await refreshBoard(box.root, new AbortController().signal, { start: (command, args, options) => {
    spawned = { command, args, options };
    const child = new EventEmitter(); child.exitCode = 0; child.signalCode = null;
    queueMicrotask(() => child.emit('close', 0));
    return child;
  } });
  assert.deepEqual(spawned.args.slice(-4), ['sentinel', 'run', '--health-only', '--json']);
  assert.equal(spawned.options.cwd, box.root);
  for (const name of CALLER_SESSION_NAMES) assert.equal(name in spawned.options.env, false, `${name} stays out of the scan`);
  assert.equal(spawned.options.env.PULLBOARD_HOME, process.env.PULLBOARD_HOME, 'everything else reaches the scan');
  assert.deepEqual(spawned.options.env, withoutCallerSession(process.env));
  for (const name of CALLER_SESSION_NAMES) delete process.env[name];
  const asView = await run();
  assert.equal(asView.code, 0, asView.stderr);
  assert.ok(JSON.parse(asView.stdout).health, 'the scan ran and recorded health');
  assert.equal(JSON.parse(readFileSync(checkoutSessionFile(repoInfo(box.root)), 'utf8')).digest, later, 'the scan never rebinds the checkout');
});
