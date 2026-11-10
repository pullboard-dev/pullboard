/** The wait audit sees each surface over budget, files one item per cause, and reclaims dead holders [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../../apps/cli/tests/fixtures/board.js';
import { addItem } from '../../../store/index.js';
import { claim } from '../../../store/index.js';
import { register } from '../../../store/index.js';
import { release } from '../../../store/index.js';
import { shout } from '../../../store/index.js';
import { openWaitKey } from '../../index.js';
import { recordWaits } from '../../index.js';
import { waitBudgets } from '../../index.js';
import { waitItemFields } from '../../index.js';
import { waitLines } from '../../index.js';
import { waitsSnapshot } from '../../index.js';
import { startServeSentinel } from '../../index.js';
import { localCensus } from '../../src/io/surfaces.js';
import { readRunnerJobs } from '../../src/io/surfaces.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { waitForCondition } from '../../../../apps/cli/tests/fixtures/runner/holders.js';

/** Whether a pid is gone. */
function gone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

const MINUTE = 60_000;

/** A real board file, a real repository folder and a machine home, all owned by the test. */
function machine(t) {
  let at = Date.now();
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence', clock: { now: () => new Date(at) } });
  const root = temporaryDirectory('pullboard-waits-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commonDir = join(root, 'repo.git');
  mkdirSync(join(commonDir, 'pullboard'), { recursive: true });
  mkdirSync(join(root, 'home', 'handoff-queue'), { recursive: true });
  const boardFile = board.db.prepare('PRAGMA database_list').get().file;
  const paths = { commonDir, boardFile, machineHome: join(root, 'home'), handoffQueue: join(root, 'home', 'handoff-queue') };
  register(board, { lane: 'coordinator', path: root });
  const children = [];
  t.after(() => { for (const child of children) try { process.kill(child, 'SIGKILL'); } catch { /* Gone already. */ } });
  /** Start a real sleeping process and return its pid. */
  const sleeper = (options = {}) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', ...options });
    children.push(child.pid);
    return child;
  };
  /** The ports recordWaits files through: real board moves on the real board file. */
  const ports = (extra = {}) => ({
    openKey: key => openWaitKey(board.db, key),
    // The same fields and validation the CLI's ordered addItem move runs, so a refused item fails here too.
    fileItem: draft => addItem(board, waitItemFields(draft, 'coordinator')),
    shout: text => shout(board, { from: 'sentinel', to: 'coordinator', lanes: [], text }),
    ...extra,
  });
  // Only this test's own processes are in view, so a real orphan or loop elsewhere on the machine is never touched.
  const census = () => new Map([...localCensus()].filter(([pid]) => children.includes(pid)));
  const snapshot = (options = {}) => waitsSnapshot({ paths, budgets: waitBudgets(), hosts: [], census: census(), ...options });
  const items = () => board.db.prepare("SELECT item_id, item_title, item_brief, item_route, item_check FROM item WHERE item_brief LIKE '%Wait key:%'").all();
  return { board, root, paths, sleeper, children, ports, snapshot, census, items, setNow: value => { at = value; } };
}

/** A resource database with the queue's holder and waiter columns the audit reads. */
function resourceDatabase(file, holders, waiters) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE holder (token TEXT PRIMARY KEY, name TEXT, pid INTEGER, agent TEXT, since TEXT, item TEXT DEFAULT '', kind TEXT DEFAULT '');
    CREATE TABLE waiter (ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, name TEXT, pid INTEGER, agent TEXT, since TEXT, item TEXT DEFAULT '', kind TEXT DEFAULT '');
    CREATE TABLE runner_unavailable (host TEXT PRIMARY KEY, since TEXT, detail TEXT DEFAULT '')`);
  for (const [index, row] of holders.entries()) db.prepare('INSERT INTO holder (token, name, pid, agent, since) VALUES (?, ?, ?, ?, ?)').run(`h${index}`, row.name, row.pid, row.agent, row.since);
  for (const [index, row] of waiters.entries()) db.prepare('INSERT INTO waiter (token, name, pid, agent, since) VALUES (?, ?, ?, ?, ?)').run(`w${index}`, row.name, row.pid, row.agent, row.since);
  db.close();
}

test('a checkout lease held past budget while commands wait is filed once, then deduplicated, and a dead holder is pruned [C7]', async t => {
  const m = machine(t);
  const holder = m.sleeper(), waiter = m.sleeper();
  const ago = minutes => new Date(Date.now() - minutes * MINUTE).toISOString();
  resourceDatabase(join(m.paths.commonDir, 'pullboard', 'resources.sqlite'),
    [{ name: 'checkout-session:abc', pid: holder.pid, agent: 'coordinator', since: ago(27) }],
    [{ name: 'checkout-session:abc', pid: waiter.pid, agent: 'core-1', since: ago(12) }]);
  const first = await m.snapshot();
  const row = first.rows.find(entry => entry.surface === 'checkout-lease');
  assert.equal(row.breach, true, 'a 27 minute lease with a 12 minute waiter is over budget');
  assert.equal(row.waiters[0].pid, waiter.pid);
  assert.match(waitLines(first).join('\n'), /OVER {2}checkout-lease/u);
  const recorded = await recordWaits(first, m.ports());
  assert.equal(recorded.filed.length, 1);
  const [item] = m.items();
  assert.match(item.item_brief, new RegExp(`pid ${holder.pid}`, 'u'), 'the item names the holder');
  assert.match(item.item_brief, /core-1 \(pid \d+\): waited 12 min/u, 'and the waiter with its age');
  assert.match(item.item_brief, /Evidence: .*resources\.sqlite/u, 'and the evidence path');
  const again = await recordWaits(await m.snapshot(), m.ports());
  assert.equal(again.filed.length, 0, 'the same cause files no second item');
  assert.equal(again.deduplicated.length, 1);
  process.kill(holder.pid, 'SIGKILL');
  await waitForCondition(() => gone(holder.pid), 'the killed holder exits');
  const pruned = [];
  const dead = await recordWaits(await m.snapshot(), m.ports({ prunePools: scope => pruned.push(scope) }));
  assert.deepEqual(pruned, ['repo'], 'a gone holder is reclaimed through the queue\'s own prune');
  assert.ok(dead.reclaimed.some(line => /pruned/u.test(line)));
});

test('a board writer holding past two seconds is a breach and a dead writer marker is removed [C7]', async t => {
  const m = machine(t);
  const directory = `${m.paths.boardFile}.write-holders`;
  mkdirSync(directory, { recursive: true });
  const live = m.sleeper();
  await waitForCondition(() => !gone(live.pid), 'the writer runs');
  writeFileSync(join(directory, `${live.pid}-00000000-0000-0000-0000-000000000001.json`), JSON.stringify({ version: 1, pid: live.pid,
    started: '', processSha256: 'a'.repeat(64), command: 'merged', seat: 'coordinator', acquiredAt: Date.now() - 5_000, contender: true }));
  const deadMarker = join(directory, '4194301-00000000-0000-0000-0000-000000000002.json');
  writeFileSync(deadMarker, JSON.stringify({ version: 1, pid: 4194301, started: 'x', processSha256: 'b'.repeat(64), command: 'add', seat: 'core-2', acquiredAt: Date.now() - 60_000 }));
  const snapshot = await m.snapshot();
  const row = snapshot.rows.find(entry => entry.surface === 'board-write' && entry.pid === live.pid);
  assert.equal(row.breach, true, 'five seconds against a two second database budget');
  assert.equal(row.holder, 'merged by coordinator');
  const recorded = await recordWaits(snapshot, m.ports());
  assert.equal(existsSync(deadMarker), false, 'the dead pid\'s marker is reclaimed at once');
  assert.equal(recorded.filed.length, 1);
  assert.match(m.items()[0].item_brief, /Doing: node/u, 'the item says what the holder was doing');
});

test('a resource write queue whose writer holds past budget is filed, and a dead writer lock is reclaimed [C7]', async t => {
  const m = machine(t);
  const queue = join(m.paths.machineHome, 'resources.sqlite.writes');
  mkdirSync(queue, { recursive: true });
  const live = m.sleeper();
  writeFileSync(join(queue, 'writer.lock'), `${live.pid} ${Date.now() - 4_000} owner`);
  writeFileSync(join(queue, `${'1'.padStart(24, '0')}-000000-release-${live.pid}-0-abcdef12`), '{}');
  const held = await m.snapshot();
  assert.equal(held.rows.find(entry => entry.surface === 'resource-write').breach, true);
  assert.equal((await recordWaits(held, m.ports())).filed.length, 1);
  writeFileSync(join(queue, 'writer.lock'), `4194301 ${Date.now() - 4_000} owner`);
  const dead = await recordWaits(await m.snapshot(), m.ports());
  assert.equal(existsSync(join(queue, 'writer.lock')), false, 'a lock naming a gone pid is removed');
  assert.ok(dead.reclaimed.some(line => /writer\.lock/u.test(line)));
});

test('a hand-off place waiting past budget is filed and a reservation of a gone submitter is dropped [C7]', async t => {
  const m = machine(t);
  const place = join(m.paths.handoffQueue, '000000000001-job-a.json');
  writeFileSync(place, '{}');
  const old = (Date.now() - 5 * MINUTE) / 1000;
  utimesSync(place, old, old);
  const reserved = join(m.paths.handoffQueue, '000000000002-job-b.reserved');
  writeFileSync(reserved, JSON.stringify({ pid: 4194301, started: 'x' }));
  const snapshot = await m.snapshot();
  assert.equal(snapshot.rows.find(entry => entry.surface === 'handoff-queue').breach, true);
  const recorded = await recordWaits(snapshot, m.ports());
  assert.equal(existsSync(reserved), false);
  assert.equal(recorded.filed.length, 0, 'the row was reclaimed this pass; the next pass files the remaining wait');
  assert.equal((await recordWaits(await m.snapshot(), m.ports())).filed.length, 1);
});

test('a gate with no span progress past five minutes and a landing run past fifteen are filed per cause [C7]', async t => {
  const m = machine(t);
  const now = Date.now();
  const job = m.board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  job.run('handoff-drive-1', 'gate', 41, 'shard.started', 'fallback:status:4194301', now + MINUTE, now - 60 * MINUTE, now);
  m.board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_at) VALUES (?, ?, ?)').run('handoff-drive-1', 'running', now - 50 * MINUTE);
  job.run('gate-drive:fresh', 'gate-drive', 42, 'gate.progress', 'gate-driver:x', now + MINUTE, now - 60 * MINUTE, now);
  mkdirSync(join(m.paths.commonDir, 'pullboard', 'gate-spans'), { recursive: true });
  writeFileSync(join(m.paths.commonDir, 'pullboard', 'gate-spans', `${new Date(now).toISOString().slice(0, 10)}.jsonl`),
    JSON.stringify({ v: 1, job: 'fresh', phase: 'run', start: new Date(now - 2_000).toISOString(), end: new Date(now - 1_000).toISOString() }) + '\n');
  job.run('land:run:1', 'landing-run', null, 'started', 'pid-4194301', now + MINUTE, now - 20 * MINUTE, now);
  const snapshot = await m.snapshot();
  const gates = snapshot.rows.filter(entry => entry.surface === 'gate');
  assert.deepEqual(gates.map(entry => [entry.holder.split(' ')[0], entry.breach]).sort(), [['#41', true], ['#42', false]], 'a span keeps a gate in budget');
  assert.match(gates.find(entry => entry.breach).detail, /\(gone\)/u, 'the lease owner\'s gone pid is named');
  assert.equal(snapshot.rows.find(entry => entry.surface === 'landing-run').breach, true);
  const recorded = await recordWaits(snapshot, m.ports());
  assert.equal(recorded.filed.length, 2);
  assert.equal(m.board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'shout'").get().n >= 1, true, 'the run is recorded on the board');
});

test('a runner job past twenty minutes is filed with its host, job folder and test [C7]', async t => {
  const m = machine(t);
  const ps = ['  500   90  11:32:22 /u/bin/node /Users/r/.pullboard-runner/runtime/abc/src/runner-worker.js',
    '  501  500     11:32:00 /u/bin/node /Users/r/.pullboard-runner/jobs/job-1/checkout/test/relay-client.test.js',
    '  600    1     03:00 /u/bin/node /Users/r/.pullboard-runner/runtime/abc/src/runner-worker.js'].join('\n');
  const cwd = 'p501\nfcwd\nn/Users/r/.pullboard-runner/jobs/job-1/checkout\n';
  const exec = (command, args, options, done) => done(null, `${ps}\n__CWD__\n${cwd}`);
  const snapshot = await m.snapshot({ hosts: ['runner@10.0.0.53'], readers: { runners: (hosts, now, options) => readRunnerJobs(hosts, now, { ...options, exec }) } });
  const jobs = snapshot.rows.filter(entry => entry.surface === 'runner-job');
  const hung = jobs.find(entry => entry.pid === 500);
  assert.equal(hung.breach, true);
  assert.match(hung.holder, /relay-client\.test\.js/u);
  assert.match(hung.detail, /jobs\/job-1/u);
  assert.equal(jobs.find(entry => entry.pid === 600).breach, false);
  assert.match(jobs.find(entry => entry.pid === 600).detail, /orphaned/u);
  assert.equal((await recordWaits(snapshot, m.ports())).filed.length, 1);
});

test('an orphaned Pullboard process past five minutes is stopped by exact pid with SIGTERM [C7]', async t => {
  const m = machine(t);
  const folder = privateFixtureFiles('pullboard-orphan-').root;
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const script = join(folder, 'leaked-dispatcher.js');
  writeFileSync(script, 'setTimeout(() => {}, 600000);\n');
  const pidFile = join(folder, 'pid');
  // The parent shell exits at once, so the leaked process is reparented exactly as a leaked dispatcher is.
  execFileSync('/bin/sh', ['-c', `"${process.execPath}" "${script}" >/dev/null 2>&1 & echo $! > "${pidFile}"`]);
  const pid = Number(execFileSync('/bin/cat', [pidFile], { encoding: 'utf8' }).trim());
  m.children.push(pid);
  await waitForCondition(() => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim() !== '', 'the leaked process runs');
  if (execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim() !== '1' || !/\/(?:T|tmp)\/pullboard-/u.test(script)) {
    t.skip('this platform reparents to a subreaper or keeps temp folders elsewhere');
    return;
  }
  // The census reads it as ten minutes old, so the five minute budget is past without a wait.
  const aged = new Map([...m.census()].map(([key, row]) => [key, { ...row, ageMs: row.ageMs + 10 * MINUTE }]));
  const snapshot = await m.snapshot({ census: aged });
  const row = snapshot.rows.find(entry => entry.surface === 'orphan' && entry.pid === pid);
  assert.equal(row.breach, true);
  const recorded = await recordWaits(snapshot, m.ports());
  assert.ok(recorded.reclaimed.some(line => line.includes(`SIGTERM pid ${pid}`)));
  await waitForCondition(() => gone(pid), 'the orphan exits on SIGTERM');
});

test('a claim kept alive only by an orphaned heartbeat loop is a breach: the loop stops and the claim returns to the board [C7]', async t => {
  const m = machine(t);
  const worktree = join(m.root, 'seat');
  mkdirSync(worktree);
  m.setNow(Date.now() - 45 * MINUTE);
  const seat = register(m.board, { lane: 'core', path: worktree });
  const id = addItem(m.board, { by: 'coordinator', lane: 'core', title: 'Held work', criterion: 'It works.' });
  claim(m.board, id, { agentId: seat, lane: 'core', leaseMs: 4 * 3_600_000, head: 'a'.repeat(40),
    freeze: item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'work', check: 'true', rows: [] }), digest: 'fixture' }) });
  m.setNow(Date.now());
  const presence = new DatabaseSync(`${m.paths.boardFile}.presence.sqlite`);
  presence.exec('CREATE TABLE IF NOT EXISTS heartbeat(seat TEXT PRIMARY KEY, at TEXT NOT NULL)');
  presence.prepare('INSERT OR REPLACE INTO heartbeat (seat, at) VALUES (?, ?)').run(seat, new Date().toISOString());
  presence.close();
  const pidFile = join(m.root, 'loop.pid');
  // Only the loop goes to the background, with every stream closed, so this launch returns as soon as the shell exits.
  execFileSync('/bin/sh', ['-c', `/bin/sh -c 'while true; do echo heartbeat >/dev/null; sleep 1; done' </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"`],
    { cwd: worktree, stdio: 'ignore' });
  const loop = Number(execFileSync('/bin/cat', [pidFile], { encoding: 'utf8' }).trim());
  m.children.push(loop);
  const snapshot = await m.snapshot({ readers: { heartbeat: { commitMs: () => 0 } } });
  const row = snapshot.rows.find(entry => entry.surface === 'heartbeat-claim');
  assert.equal(row.breach, true, 'forty-five quiet minutes behind a fresh heartbeat');
  if (!row.heartbeat.loops.length || !row.heartbeat.loops.every(entry => entry.orphaned)) {
    t.skip('lsof could not name the loop\'s folder, or the loop kept a live parent here');
    return;
  }
  const recorded = await recordWaits(snapshot, m.ports({ release: async claimRow => {
    release(m.board, claimRow.item, 'coordinator', '', { seat: claimRow.seat, lastSeen: claimRow.lastSeen }, 'BLOCKED');
    return true;
  } }));
  await waitForCondition(() => gone(loop), 'the heartbeat loop stops');
  assert.equal(m.board.db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(id).item_status, 'open', 'next can hand the item to a live seat');
  assert.ok(recorded.reclaimed.some(line => line.includes(`#${id}: released`)));
});

test('the view runs the wait audit every minute, one pass at a time per board [C7]', async () => {
  const timers = [], audited = [];
  const observer = startServeSentinel({ projects: () => [{ root: '/one' }, { root: '/one' }], enabled: () => true,
    every: () => ({ unref() {} }), cancel: () => {},
    liveEvery: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; }, liveCancel: () => {},
    run: async () => {}, runCanary: async () => {}, canary: () => ({ close: async () => {} }), recover: async () => false,
    audit: async root => { audited.push(root); } });
  const audit = timers.find(timer => timer.callback.name === 'auditTick');
  assert.ok(audit.ms <= 60_000, 'the audit runs at least once a minute');
  await audit.callback();
  assert.deepEqual(audited, ['/one']);
  await observer.close();
});

test('with sixty breaches the run records one shout line under 400 characters on the real board [C7]', async t => {
  const m = machine(t);
  const rows = Array.from({ length: 60 }, (_, index) => ({ surface: 'gate', key: `gate:#${1000 + index}:gate`, holder: `#${1000 + index} gate shard.started ${'x'.repeat(80)}`,
    pid: null, ageMs: 40 * 3_600_000, budgetName: 'gateProgressMs', budgetMs: 300_000, breach: true, waiters: [], oldestWaiterMs: 0,
    context: null, detail: 'lease owner fallback:status:1 (gone)', evidence: '/repo/.git/pullboard/board.sqlite' }));
  const said = [];
  const recorded = await recordWaits({ budgets: waitBudgets(), rows, notes: [] },
    m.ports({ shout: text => { said.push(text); return shout(m.board, { from: 'sentinel', to: 'coordinator', lanes: [], text }); } }));
  assert.equal(recorded.filed.length, 60, 'each cause still gets its own item with the detail');
  assert.equal(said.length, 1);
  assert.ok(said[0].length < 400, `the shout is ${said[0].length} characters`);
  assert.doesNotMatch(said[0], /\n/u, 'one line');
  // Short ids may all fit; long ones end in "and N more". Either way the line keeps its shape.
  assert.match(said[0], new RegExp(`^waits: 60 over budget, filed #${recorded.filed[0].id} #${recorded.filed[1].id} [#\\d ]*(?:and \\d+ more)?, reclaimed 0; pullboard waits for detail$`, 'u'));
});

test('waits record files a mid item add accepts: Files: naming the holder\'s source, a Test: line and a check [C7]', async t => {
  const m = machine(t);
  const holder = m.sleeper(), waiter = m.sleeper();
  const ago = minutes => new Date(Date.now() - minutes * MINUTE).toISOString();
  resourceDatabase(join(m.paths.commonDir, 'pullboard', 'resources.sqlite'),
    [{ name: 'checkout-session:abc', pid: holder.pid, agent: 'coordinator', since: ago(27) }],
    [{ name: 'checkout-session:abc', pid: waiter.pid, agent: 'core-1', since: ago(12) }]);
  const snapshot = await m.snapshot();
  // The holder's command line names the CLI command that held the lease, as `merged` did on 9 Nov.
  const row = { ...snapshot.rows.find(entry => entry.surface === 'checkout-lease'), context: 'node /repo/bin/pullboard.js merged 3930 a6a7674098' };
  const recorded = await recordWaits({ ...snapshot, rows: [row] }, m.ports());
  assert.equal(recorded.filed.length, 1, 'the real add validation accepts the item');
  const [item] = m.items();
  assert.equal(item.item_route, 'mid', 'routed so a Sonnet builds it cold');
  assert.match(item.item_brief, /^Files:\n- apps\/cli\/src\/io\/commands\/merged\.js\n- packages\/seats\/src\/io\/agent\/session\.js$/mu, 'the holder\'s source and the surface code');
  assert.match(item.item_brief, /^Test: /mu);
  assert.equal(item.item_check, "node apps/cli/pullboard.js waits check 'checkout-lease:repo:checkout-session:abc:coordinator'", 'its check is the audit for this one cause');
  const bare = { by: 'coordinator', lane: 'core', title: 'bare', criterion: '1. It holds. [test]', brief: 'no sections', route: 'mid', check: item.item_check };
  assert.throws(() => addItem(m.board, bare), /NO_BRIEF|Files:/u, 'a brief without Files: and Test: is the refusal this guards against');
});
