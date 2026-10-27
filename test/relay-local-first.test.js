/** Local first: a linked board reads and moves locally whether or not the relay answers [H21,H5,H16]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCESS_WINDOW_MS } from '../relay/auth.js';
import * as store from '../src/board.js';
import { captureBoardChanges } from '../src/board-capture.js';
import { SENDER_WORKER } from '../src/relay-local-first.js';
import { outboxGuardFile } from '../src/relay-outbox-guard.js';
import { undoQueued } from '../src/relay-outbox-undo.js';
import { runFixtureChildAsync, runFixtureGit } from './fixture-child.js';
import { relayClientFixture, relayFixtureChild } from './relay-client-fixture.js';

const CLI = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));
// Budget: the criterion's bar for a move or a read, measured from spawn to exit of the real CLI.
const LOCAL_MS = 1_000;
// Budget: how long a test waits for the background sender to reach the relay; it polls every 200 ms here.
const SENDER_WAIT_MS = 20_000;

/** Turn the board's committed relay.outbox setting on, as its coordinator would. */
function enableOutbox(box) {
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, relay: { outbox: true } }, null, 2) + '\n');
  // The board's own commit hook runs pullboard, so this private PATH gets the CLI under test.
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`, { mode: 0o700 });
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): this board is local first'], { cwd: box.root, env: box.env });
}

/** The machine's background sender switched on, polling fast and leaving soon after the last nudge. */
function senderEnv(env) {
  const next = { ...env, PULLBOARD_RELAY_SENDER_PULL_MS: '200', PULLBOARD_RELAY_SENDER_IDLE_MS: '3000' };
  delete next.PULLBOARD_RELAY_SENDER_BACKGROUND;
  return next;
}

/** The machine sender's claim file under an environment's private pullboard home. */
function senderPid(env) {
  return join(env.PULLBOARD_HOME, 'relay-sender', 'sender.pid');
}

/** Read exact worker identities and scope this simulated machine to its private fixture checkout. */
function senderProcesses(root) {
  const expected = realpathSync(root);
  const rows = execFileSync('ps', ['-Ao', 'pid=,lstart=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => /^\s*(\d+)\s+(.+)$/u.exec(line))
    .filter(match => match && match[2].endsWith(SENDER_WORKER))
    .map(match => ({ pid: Number(match[1]), identity: match[2] }));
  const owned = rows.filter(record => {
    try {
      const cwd = process.platform === 'linux' ? readlinkSync(`/proc/${record.pid}/cwd`)
        : execFileSync('lsof', ['-a', '-p', String(record.pid), '-d', 'cwd', '-Fn'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').find(line => line.startsWith('n'))?.slice(1);
      return cwd === expected;
    } catch (error) {
      if ((error.code === 'ENOENT' && process.platform === 'linux') || error.status === 1) return false;
      throw error;
    }
  });
  return { owned, others: rows.length - owned.length };
}

/** Stop only verified PID/start/command/cwd identities from this fixture; other test homes stay untouched. */
async function stopSender(root) {
  for (const record of senderProcesses(root).owned) {
    const current = senderProcesses(root).owned.find(candidate => candidate.pid === record.pid);
    if (!current || current.identity !== record.identity) continue;
    try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    const started = record.identity.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})/u)?.[1].replace(/\s+/gu, ' ');
    assert.ok(started, 'the verified sender has a stable start identity');
    const deadline = Date.now() + 5000; // budget: the verified fixture worker normally exits immediately.
    let stopped = false;
    while (Date.now() < deadline) {
      let row;
      try { row = execFileSync('ps', ['-p', String(record.pid), '-o', 'lstart=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { stopped = true; break; }
      const state = /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/u.exec(row);
      assert.ok(state, 'post-signal sender start/state is readable');
      if (state[1].replace(/\s+/gu, ' ') !== started || state[2].startsWith('Z')) { stopped = true; break; }
      await new Promise(next => setTimeout(next, 20));
    }
    assert.ok(stopped, `fixture sender ${record.pid} exited after its verified signal`);
  }
}

/** Wait until `ready()` holds, or fail naming what never happened and what `detail()` says. */
async function eventually(what, ready, detail = () => '') {
  const deadline = Date.now() + SENDER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise(next => setTimeout(next, 50));
  }
  assert.fail(`${what} did not happen within ${SENDER_WAIT_MS} ms${String(await detail()) ? `\n${await detail()}` : ''}`);
}

/**
 * Run the real CLI in `cwd` and measure it apart from any sender it starts: a preload counts every network call this
 * foreground process makes, and the sender, a separate process, is never counted.
 */
async function local(box, t, cwd, env, name, args) {
  const trace = join(dirname(box.root), `${name}-fetches`);
  const preload = join(dirname(box.root), `${name}-preload.mjs`);
  writeFileSync(preload, [
    "import { appendFileSync } from 'node:fs';",
    'const fetch = globalThis.fetch;',
    '/** Record only that this foreground process attempted network IO, never its arguments. */',
    'globalThis.fetch = (...args) => {',
    `  appendFileSync(${JSON.stringify(trace)}, 'fetch\\n', { mode: 0o600 });`,
    '  return fetch(...args);',
    '};',
  ].join('\n'), { mode: 0o600 });
  const running = runFixtureChildAsync(process.execPath, ['--import', preload, CLI, ...args, '--json'], { cwd, env });
  // Budget: well past the one-second bar, so a slow command fails its assertion instead of hanging the file.
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 10_000);
  let result;
  try { result = await running; } finally { clearTimeout(timer); }
  const fetches = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').length : 0;
  t.diagnostic(JSON.stringify({ name, elapsedMs: result.elapsedMs, status: result.status, foregroundFetches: fetches }));
  assert.equal(result.status, 0, result.context);
  assert.ok(result.elapsedMs < LOCAL_MS, `${name} took ${result.elapsedMs} ms; a local-first command returns within one second`); // budget: declared by #1013's frozen bar: a local move or read returns within one second.
  assert.equal(fetches, 0, `${name} made no network call`);
  return { document: JSON.parse(result.stdout), stderr: result.stderr };
}

/** The shout texts a board export holds. */
function shoutTexts(exported) {
  return exported.tables.shout.map(row => row.shout_text);
}

/** A local-first board linked to the real relay, with the machine sender on for its commands. */
async function linkedBoard(t) {
  // Registered before the fixture's own cleanup, so the sender stops before the board's folder is removed.
  const sender = {};
  t.after(() => sender.root && stopSender(sender.root));
  const box = await relayClientFixture(t);
  enableOutbox(box);
  assert.equal((await box.link()).code, 0, 'the real relay accepts the board first');
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).baselineAccepted, true);
  sender.root = box.root;
  sender.env = senderEnv(box.env);
  return { box, env: sender.env };
}

/** The machine sender's short log, for a failure message. */
function senderLog(env) {
  try { return readFileSync(join(env.PULLBOARD_HOME, 'relay-sender', 'sender.log'), 'utf8'); } catch { return '(no sender log)'; }
}

/** Whether the relay holds a move whose sealed record the relay acknowledged for this shout's send. */
function outboxEmpty(box) {
  return !existsSync(join(dirname(box.linkFile), 'relay-outbox.sealed'));
}

test('a move and a read return within a second with no network call while the sender holds the relay lock, and no read takes a lock [H21,H5,H16]', async t => {
  const { box, env } = await linkedBoard(t);
  // The sender's relay lock and the outbox guard are both held by this test process for the whole check.
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  t.after(() => rmSync(lock, { recursive: true, force: true }));

  for (const read of [['status'], ['list'], ['export'], ['lanes']]) await local(box, t, box.root, env, `held-${read[0]}`, read);
  const guard = new DatabaseSync(outboxGuardFile(box.linkFile));
  guard.exec('BEGIN EXCLUSIVE');
  try {
    for (const read of [['status'], ['export']]) await local(box, t, box.root, env, `guarded-${read[0]}`, read);
  } finally { guard.exec('COMMIT'); guard.close(); }

  const text = 'A move while the sender holds the relay lock';
  await local(box, t, box.root, env, 'held-move', ['shout', 'all', text]);
  const exported = await local(box, t, box.root, env, 'held-export', ['export']);
  assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1, 'the move is on the local board exactly once');
  const status = await local(box, t, box.root, env, 'held-status', ['status']);
  assert.deepEqual(status.document.relay.outbox.map(move => move.operation), ['shout'], 'status lists the move as queued for the relay');

  rmSync(lock, { recursive: true, force: true });
  const acks = box.moveAcks.length;
  await local(box, t, box.root, env, 'released-status', ['status']);
  await eventually('the sender sends the queued move once the relay lock is free', () => outboxEmpty(box) && box.moveAcks.length > acks, () => senderLog(env));
});

test('a locally known revoked seat cannot queue or apply a move and retains earlier valid outbox history [H2,H9,H21]', async t => {
  const { box, env } = await linkedBoard(t);
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  const text = 'A valid move queued before this seat was revoked';
  await local(box, t, box.root, env, 'before-local-revocation', ['shout', 'all', text]);
  const exported = await local(box, t, box.root, env, 'before-revocation-export', ['export']);
  const actor = exported.document.tables.shout.find(row => row.shout_text === text).shout_from;
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  // The real phone-approved revocation flow is covered in relay-agent; here its persisted marker isolates offline admission.
  state.agentTokens ??= {};
  state.agentTokens[actor] = { ...state.agentTokens[actor], revoked: true };
  writeFileSync(box.linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
  const sealed = join(dirname(box.linkFile), 'relay-outbox.sealed');
  const generation = join(dirname(box.linkFile), 'relay-outbox.generation');
  const beforeOutbox = readFileSync(sealed);
  const beforeGeneration = readFileSync(generation, 'utf8');
  const calls = box.calls.length;
  const refused = await runFixtureChildAsync(process.execPath,
    [CLI, 'shout', 'all', 'A revoked seat must not create this move', '--json'], { cwd: box.root, env });
  assert.equal(refused.status, 1, refused.context);
  assert.equal(JSON.parse(refused.stdout).error.code, 'TOKEN_REVOKED');
  assert.equal(box.calls.length, calls, 'known revocation is refused without network or token minting');
  assert.equal(readFileSync(sealed).equals(beforeOutbox), true, 'earlier valid queued moves remain byte-identical');
  assert.equal(readFileSync(generation, 'utf8'), beforeGeneration, 'a refused move never advances the outbox generation');
  const after = await local(box, t, box.root, env, 'after-revocation-export', ['export']);
  assert.deepEqual(after.document.tables, exported.document.tables, 'the refused move changes no native board row');
});

test('a seat registration waits for relay authority while ordinary moves and reads stay local [H21,H5,H16]', async t => {
  const { box, env } = await linkedBoard(t);
  const agentPath = join(dirname(box.root), 'local-first-registration-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/local-first-registration', agentPath], { cwd: box.root, env: box.env });

  let releaseRegistration;
  const registrationResponse = new Promise(resolve => { releaseRegistration = resolve; });
  let registrationReached = false;
  box.beforeNextMove(async () => {
    registrationReached = true;
    await registrationResponse;
  });
  const joining = runFixtureChildAsync(process.execPath,
    [CLI, 'join', box.lane, '--model', 'fixture-model', '--json'], { cwd: agentPath, env });
  let joinResult;
  try {
    await eventually('the genuine agent registration reaches the relay', () => registrationReached,
      () => `join exit code: ${joining.child.exitCode ?? 'still running'}`);
    assert.equal(joining.child.exitCode, null, 'join stays pending while the relay holds its registration response');

    const text = 'An ordinary move while registration waits for authority';
    await local(box, t, box.root, env, 'registration-held-shout', ['shout', 'all', text]);
    const status = await local(box, t, box.root, env, 'registration-held-status', ['status']);
    assert.deepEqual(status.document.relay.outbox.map(move => move.operation), ['shout'], 'status reads the local move without waiting for registration');
    const exported = await local(box, t, box.root, env, 'registration-held-export', ['export']);
    assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1, 'the ordinary move is present locally while registration is pending');
  } finally {
    releaseRegistration();
    joinResult = await joining;
  }
  assert.equal(joinResult.status, 0, joinResult.context);
  assert.match(JSON.parse(joinResult.stdout).agent, new RegExp(`^${box.lane}-[1-9][0-9]*$`, 'u'), 'the real join completes in its configured lane after the authority response is released');
  await eventually('the background sender delivers the ordinary move after registration completes', () => outboxEmpty(box), () => senderLog(env));
});

test('a stalled relay never delays a move: it is recorded and queued, not refused [H21,H5]', async t => {
  const { box, env } = await linkedBoard(t);
  box.stallApi();
  t.after(() => box.stallApi(false));
  const text = 'Saved while the relay does not answer';
  await local(box, t, box.root, env, 'stalled-move', ['shout', 'all', text]);
  const second = await local(box, t, box.root, env, 'stalled-add', ['add', box.lane, 'Added while the relay does not answer']);
  assert.ok(Number.isSafeInteger(second.document.item.item_id), 'an add returns its item at once');
  const status = await local(box, t, box.root, env, 'stalled-status', ['status']);
  assert.deepEqual(status.document.relay.outbox.map(move => move.operation), ['shout', 'addItem'], 'both moves wait in order');
  assert.ok(status.document.relay.behind >= 2, 'status counts the queued moves');
  const exported = await local(box, t, box.root, env, 'stalled-export', ['export']);
  assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1);
});

test('a GitHub 403 never refuses or delays a move: it is recorded and queued, then sent once access returns [H21,H8]', async t => {
  const { box, env } = await linkedBoard(t);
  // End the relay's cached grant, so the sender's next send really asks GitHub, which now answers 403.
  box.advanceAuthorization(ACCESS_WINDOW_MS + 1);
  box.providerState.access = false;
  const permission = () => box.providerCalls.filter(call => call.path.endsWith('/permission')).length;
  const asked = permission();
  const text = 'Saved while GitHub refuses access';
  await local(box, t, box.root, env, 'denied-move', ['shout', 'all', text]);
  await eventually('the sender asks GitHub, which answers 403', () => permission() > asked);
  const status = await local(box, t, box.root, env, 'denied-status', ['status']);
  assert.deepEqual(status.document.relay.outbox?.map(move => move.operation), ['shout'], 'the move stays queued after the 403');
  assert.equal(status.document.relay.outboxRefusals, undefined, 'a 403 refuses nothing');
  const exported = await local(box, t, box.root, env, 'denied-export', ['export']);
  assert.equal(shoutTexts(exported.document).filter(row => row === text).length, 1, 'the move is recorded here');

  box.providerState.access = true;
  box.advanceAuthorization(ACCESS_WINDOW_MS + 1);
  await local(box, t, box.root, env, 'restored-status', ['status']);
  await eventually('the sender sends the move once GitHub answers again', () => outboxEmpty(box), () => senderLog(env));
});

test('one background sender per machine sends each new move once, asks GitHub once per window, pulls other machines\' moves, and the relay reads none [H21,H5,H15]', async t => {
  const { box, env } = await linkedBoard(t);
  const printed = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code);
  const permission = () => box.providerCalls.filter(call => call.path.endsWith('/permission')).length;
  const asked = permission();
  const acks = box.moveAcks.length;

  const texts = ['first burst move', 'second burst move', 'third burst move'];
  let senders = 0, otherFixtures = 0;
  const sampling = setInterval(() => {
    const observed = senderProcesses(box.root);
    senders = Math.max(senders, observed.owned.length);
    otherFixtures = Math.max(otherFixtures, observed.others);
  }, 20);
  try {
    await Promise.all(texts.map((text, index) => local(box, t, box.root, env, `burst-${index}`, ['shout', 'all', text])));
    await eventually('the sender sends the burst', () => outboxEmpty(box), () => senderLog(env));
  } finally { clearInterval(sampling); }
  t.diagnostic(JSON.stringify({ privateFixtureSenderPeak: senders, otherFixtureWorkersObserved: otherFixtures }));
  assert.equal(senders, 1, 'one sender ran for this private fixture machine, however many commands nudged it');
  const sent = box.moveAcks.slice(acks);
  assert.equal(new Set(sent.map(ack => ack.event_id)).size, sent.length, 'no sequence was sent twice');
  assert.ok(permission() - asked <= 1, `the relay asked GitHub at most once for the burst (${permission() - asked})`);

  const there = await relayFixtureChild(other.root, other.env, [CLI, 'export', '--json']);
  assert.equal(there.code, 0, there.failure);
  for (const text of texts) assert.equal(shoutTexts(there.document).filter(row => row === text).length, 1, `the other machine holds "${text}" once`);

  // An agent seat on the other machine moves; its main checkout does not hold this board's coordinator (E19).
  const otherPath = join(dirname(other.root), 'other-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/other', otherPath], { cwd: other.root, env: other.env });
  const joined = await other.cliAt(otherPath, 'join', box.lane, '--model', 'fixture-model');
  assert.equal(joined.code, 0, joined.failure);
  const reply = 'a move from the other machine';
  const shouted = await other.cliAt(otherPath, 'shout', 'all', reply);
  assert.equal(shouted.code, 0, shouted.failure);
  const otherStatus = await other.cli('status');
  assert.equal(otherStatus.document.relay.outbox, undefined, 'the other machine sent its move');
  await eventually('the sender pulls the other machine\'s move with no sync here', async () => {
    const here = await local(box, t, box.root, env, 'pulled-export', ['export']);
    return shoutTexts(here.document).includes(reply);
  }, () => senderLog(env));

  const relayFiles = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file); else relayFiles.push(file);
    }
  };
  walk(box.relayDirectory);
  assert.ok(relayFiles.length > 0, 'the relay stored the board');
  for (const file of relayFiles) {
    const bytes = readFileSync(file);
    for (const text of [...texts, reply]) assert.equal(bytes.includes(text), false, `the relay cannot read "${text}" in ${file}`);
  }
});

/** Join a real agent worktree beside this machine's main checkout before the outage. */
async function seat(box, name) {
  const path = join(dirname(box.root), name);
  runFixtureGit(['worktree', 'add', '-q', '-b', `agent/${name}`, path], { cwd: box.root, env: box.env });
  const joined = await box.cliAt(path, 'join', box.lane, '--model', 'fixture-model');
  assert.equal(joined.code, 0, joined.failure);
  return { path, id: joined.document.agent };
}

test('a conflict found on sync is refused at replay with a code naming the winner, and its agent is told once [H21,H16]', async t => {
  const box = await relayClientFixture(t);
  enableOutbox(box);
  await box.link();
  const contested = (await box.cli('add', box.lane, 'Claimed on two machines')).document.item.item_id;
  const printed = await box.cli('relay', 'pair');
  const other = await box.otherDeviceJoin(printed.document.code);
  const here = await seat(box, 'here-agent');
  const otherPath = join(dirname(other.root), 'there-agent');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'agent/there', otherPath], { cwd: other.root, env: other.env });
  const there = await other.cliAt(otherPath, 'join', box.lane, '--model', 'fixture-model');
  assert.equal(there.code, 0, there.failure);
  const winner = there.document.agent;

  await box.stopRelay();
  const queued = await box.cliAt(here.path, 'claim', String(contested));
  assert.equal(queued.code, 0, `the claim succeeds here at once, with no up-front coordination: ${queued.failure}`);
  await box.restartRelay();
  const won = await other.cliAt(otherPath, 'claim', String(contested));
  assert.equal(won.code, 0, won.failure);

  const synced = await box.cli('status');
  assert.equal(synced.code, 0, synced.failure);
  const [refused] = synced.document.relay.outboxRefusals ?? [];
  assert.ok(refused, 'the later claim is refused when it replays');
  assert.equal(refused.code, 'HELD', 'the refusal carries the engine\'s own code');
  assert.equal(refused.move, `claim #${contested} by ${here.id}`);
  assert.ok(refused.earlier.some(move => move.move === `claim #${contested} by ${winner}`), 'the refusal names the winning claim and its agent');

  // The agent whose claim lost is told on its next command, once.
  const told = await runFixtureChildAsync(process.execPath, [CLI, 'status'], { cwd: here.path, env: box.env });
  assert.equal(told.status, 0, told.context);
  assert.match(told.stderr, new RegExp(`\\[RELAY_OUTBOX_REFUSED\\] the queued move claim #${contested} by ${here.id} .*\\[HELD\\].*won by sequence \\d+ claim #${contested} by ${winner}`, 'u'));
  const again = await runFixtureChildAsync(process.execPath, [CLI, 'status'], { cwd: here.path, env: box.env });
  assert.doesNotMatch(again.stderr, /RELAY_OUTBOX_REFUSED/u, 'the notice is said once');

  for (const machine of [box, other]) {
    const exported = await machine.cli('export');
    const item = exported.document.tables.item.find(row => row.item_id === contested);
    assert.equal(item.item_owner, winner, 'both machines agree the first claim the relay ordered won');
  }
});

test('a queued move is taken back row for row, its item status and row counters included, so the relay\'s order replays onto the board it was made on [H21,H16]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-undo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = store.openBoard(join(directory, 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, directory);
  store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Made before the outage' });
  const tables = ['item', 'event', 'shout', 'agent', 'board_meta', 'sqlite_sequence'];
  const image = () => JSON.stringify(tables.map(table => board.db.prepare(`SELECT * FROM ${table}`).all()));
  /** Make one move the way a local-first move is made: counters noted, rows captured. */
  const queue = async (move) => {
    const sequences = board.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all().map(row => ({ ...row }));
    const { changes } = await captureBoardChanges(move);
    return { sequences, changes: changes.map(change => Buffer.from(change).toString('base64')) };
  };
  const ordered = image();
  const queued = [
    await queue(() => store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Added ahead of the relay' })),
    await queue(() => store.shout(board, { from: 'coordinator', to: 'all', text: 'said ahead of the relay', lanes: ['app'] })),
    await queue(() => store.withdraw(board, 1, { agentId: 'coordinator', reason: 'withdrawn ahead of the relay' })),
  ];
  assert.notEqual(image(), ordered, 'the moves show on the board at once');
  assert.equal(undoQueued(board, queued), null, 'every queued move is taken back');
  assert.equal(image(), ordered, 'the board is exactly as the relay last ordered it, counters included');
  assert.equal(store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Another machine\'s add' }), 2, 'the next number is the one the relay order gives');
  assert.equal(board.db.prepare("SELECT item_status FROM item WHERE item_id = 1").get().item_status, 'open', 'the withdrawn item is open again until its move replays');
  assert.ok(board.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine_%'").get().n > 0, 'the board keeps its lifecycle triggers');
  assert.throws(() => board.db.exec("DELETE FROM event"), /APPEND_ONLY/u, 'events are append-only again after the undo');
});
