/** Checkout-session ownership and takeover behavior [B3,B7]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, fixtureChildMessage, reportFixtureChildFailure, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listResources } from '../src/resources.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const DIRS = [];
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
const SPEC = '# Session fixture\n\n## G · Goals\n- G1 [approved, must] The fixture works. | gate: true\n';
const CONFIG = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: ['docs/'] };

after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** Build a private CLI environment without ambient agent/session or Git selectors. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-agent-session-'));
  DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith('GIT_') || MARKERS.includes(key) || key === 'CLAUDE_CODE_SESSION_ID') delete base[key];
  Object.assign(base, {
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Session fixture', GIT_AUTHOR_EMAIL: 'session@example.invalid',
    GIT_COMMITTER_NAME: 'Session fixture', GIT_COMMITTER_EMAIL: 'session@example.invalid',
  });
  /** Run real Git with the private environment. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env: base });
  }
  /** Run the actual CLI with an explicit agent session or markerless terminal. */
  function run(cwd, args, { session, sessionKey = 'CLAUDE_CODE_SESSION_ID', agent = true } = {}) {
    const env = { ...base };
    if (agent) {
      env.CLAUDECODE = '1';
      if (session !== undefined) env[sessionKey] = session;
    }
    return runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  }
  return { dir, base, git, run };
}

/** Create the main checkout and one joined lane worktree with a private board. */
function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, ['init'], { agent: false }).status, 0);
  writeFileSync(join(repo, 'pullboard.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'page.txt'), 'ready\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize session fixture');
  const added = box.run(repo, ['add', 'web', 'fixture item', '--specs', 'G1', '--json'], { agent: false });
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const web = join(box.dir, 'web-agent');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/session');
  const joined = box.run(web, ['join', 'web'], { agent: false });
  assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
  return { ...box, repo, web, boardFile: resolve(repo, box.git(repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'board.sqlite') };
}

/** Capture stable board counts so a refused write proves no event, row, or shout was added. */
function boardSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

/** Keep raw ids out of SQLite and local files; only the current digest lives in this checkout’s Git directory. */
function assertNoRawSession(box, cwd, secrets, sessionKey = 'CLAUDE_CODE_SESSION_ID') {
  const file = box.boardFile;
  const dir = file.slice(0, file.lastIndexOf('/'));
  const files = readdirSync(dir).filter((name) => /board\.sqlite(?:-(?:wal|shm))?$/u.test(name));
  assert.ok(files.length, 'private SQLite board files were created');
  for (const name of files) {
    const bytes = readFileSync(join(dir, name));
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `raw session id is not persisted in ${name}`);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
    const stored = tables.flatMap((table) => db.prepare(`SELECT * FROM \"${table.replaceAll('\"', '\"\"')}\"`).all())
      .map((row) => JSON.stringify(row)).join('\\n');
    for (const secret of secrets) {
      const digest = createHash('sha256').update(JSON.stringify([sessionKey, secret])).digest('hex');
      assert.equal(stored.includes(digest), false, 'session bindings never enter shared board data');
    }
  } finally { db.close(); }
  const local = resolve(cwd, box.git(cwd, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const bindingText = readFileSync(local, 'utf8');
  for (const secret of secrets) assert.equal(bindingText.includes(secret), false);
  const binding = JSON.parse(bindingText);
  assert.equal(binding.agent, cwd === box.repo ? 'coordinator' : 'web-1');
  assert.equal(binding.digest, createHash('sha256').update(JSON.stringify([sessionKey, secrets.at(-1)])).digest('hex'));
  assert.ok(Number.isFinite(Date.parse(binding.at)));
}

test('a second session cannot write in the main checkout until takeover [B3,B7]', () => {
  const box = project();
  const first = 'claude-session-secret-first-273';
  const second = 'claude-session-secret-second-273';
  const initial = box.run(box.repo, ['shout', 'web', 'first session owns main', '--json'], { session: first });
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);
  const before = boardSnapshot(box.boardFile);
  const refused = box.run(box.repo, ['shout', 'web', 'must not land', '--json'], { session: second });
  assert.notEqual(refused.status, 0);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'NOT_YOUR_CHECKOUT');
  assert.match(error.message, /coordinator/u);
  assert.match(error.next, /pullboard worktree/u);
  assert.match(error.message, /pullboard takeover/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'refusal leaves all board counts unchanged');
  const worktrees = box.git(box.repo, 'worktree', 'list', '--porcelain');
  for (const args of [['init'], ['worktree', 'web'], ['hooks'], ['spec', 'apply'], ['hook', 'pre-commit'], ['submit', '1']]) {
    const blocked = box.run(box.repo, [...args, '--json'], { session: second });
    assert.equal(blocked.status, 1, `${args.join(' ')} must refuse another session before side effects`);
    assert.equal(JSON.parse(blocked.stdout).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardSnapshot(box.boardFile), before, `${args.join(' ')} leaves every board row intact`);
    assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), worktrees, 'the wrong session cannot create a worktree first');
  }

  const takeover = box.run(box.repo, ['takeover', '--json'], { session: second });
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  const rows = boardSnapshot(box.boardFile);
  assert.ok(rows.event.slice(before.event.length).some(row => row.event_kind === 'shout' && row.event_by === 'coordinator'), 'takeover is recorded through an existing ordered shout event');
  assert.match(rows.shout.at(-1).shout_text, /coordinator took over/);
  assert.equal(rows.shout.at(-1).shout_to, 'person');
  assert.equal(rows.shout.length, before.shout.length + 1, 'main-checkout takeover records the person notice');
  const after = box.run(box.repo, ['shout', 'web', 'second session owns main', '--json'], { session: second });
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assertNoRawSession(box, box.repo, [first, second]);
  const beforeSelf = boardSnapshot(box.boardFile);
  const self = box.run(box.repo, ['shout', 'coordinator', 'cannot address myself', '--json'], { agent: false });
  assert.notEqual(self.status, 0);
  assert.deepEqual(boardSnapshot(box.boardFile), beforeSelf, 'self-addressed shout is refused without changing the board');
});

test('lane ownership is session-scoped and takeover preserves the joined agent [B3,B7]', () => {
  const box = project();
  const first = 'codex-thread-secret-first-273';
  const second = 'codex-thread-secret-second-273';
  const claim = box.run(box.web, ['claim', '1', '--json'], { session: first, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal(claim.status, 0, `${claim.stdout}${claim.stderr}`);
  const sameSession = box.run(box.web, ['claim', '1', '--json'], { session: first, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal(sameSession.status, 0, `${sameSession.stdout}${sameSession.stderr}`);
  const before = boardSnapshot(box.boardFile);
  const refused = box.run(box.web, ['claim', '1', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' });
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, 'NOT_YOUR_CHECKOUT');
  assert.match(JSON.parse(refused.stdout).error.message, /web-1/u);
  assert.match(JSON.parse(refused.stdout).error.next, /pullboard worktree/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'refused lane write leaves event and item counts unchanged');

  const takeover = box.run(box.web, ['takeover', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  assert.equal(boardSnapshot(box.boardFile).event.length, before.event.length + 1, 'lane takeover records one event');
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_to, 'coordinator');
  const after = box.run(box.web, ['claim', '1', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assertNoRawSession(box, box.web, [first, second], 'CODEX_THREAD_ID');
});

test('no-session shells are one session and markerless terminals retain their writes [B3,B7]', () => {
  const box = project();
  const sentinel = box.run(box.web, ['claim', '1', '--json'], { session: undefined });
  assert.equal(sentinel.status, 0, `${sentinel.stdout}${sentinel.stderr}`);
  const noSessionAgain = box.run(box.web, ['claim', '1', '--json'], { session: undefined });
  assert.equal(noSessionAgain.status, 0, `${noSessionAgain.stdout}${noSessionAgain.stderr}`);
  const terminalRead = box.run(box.web, ['show', '1', '--json'], { agent: false });
  assert.equal(terminalRead.status, 0, `${terminalRead.stdout}${terminalRead.stderr}`);
  assert.equal(JSON.parse(terminalRead.stdout).item_status, 'claimed');
  const beforeIdentified = boardSnapshot(box.boardFile);
  const identified = box.run(box.web, ['release', '1', '--json'], { session: 'identified-after-sentinel-273', sessionKey: 'CODEX_SESSION_ID' });
  assert.equal(identified.status, 1);
  assert.equal(JSON.parse(identified.stdout).error.code, 'NOT_YOUR_CHECKOUT');
  assert.deepEqual(boardSnapshot(box.boardFile), beforeIdentified);
  const terminalWrite = box.run(box.web, ['shout', 'coordinator', 'the markerless terminal still works', '--json'], { agent: false });
  assert.equal(terminalWrite.status, 0, terminalWrite.stdout + terminalWrite.stderr);
  const secondSessionRead = box.run(box.web, ['show', '1', '--json'], { session: 'read-from-another-session-273' });
  assert.equal(secondSessionRead.status, 0, secondSessionRead.stdout + secondSessionRead.stderr);

  // Existing relay-person-request coverage should be retained: this private CLI fixture does not
  // establish a linked relay or inject io.personRequest, so an ordinary shout is not a substitute.
  // A decision addressed to its own sender must be refused rather than self-answered.
  const beforeSelf = boardSnapshot(box.boardFile);
  const self = box.run(box.repo, ['shout', 'coordinator', 'self decision', '--decision', '--json'], { agent: false });
  assert.notEqual(self.status, 0);
  assert.deepEqual(boardSnapshot(box.boardFile), beforeSelf, 'self-addressed decision is refused without a write');
});

test('the actual view adapter writes without taking over an agent session [B3,B7]', () => {
  const box = project();
  const owner = box.run(box.repo, ['shout', 'web', 'agent owns this checkout', '--json'], { session: 'view-owner-session-273' });
  assert.equal(owner.status, 0, owner.stdout + owner.stderr);
  const file = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const before = readFileSync(file);
  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../src/api.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../src/cli.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const response = await executeMove(process.cwd(), { verb: 'shout', args: { to: 'web', text: 'actual view action' } }, main);
    process.stdout.write(JSON.stringify(response));
  `;
  const response = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: { ...box.base, CODEX_THREAD_ID: 'other-process-view-session-273' }, encoding: 'utf8',
  });
  assert.equal(response.status, 0, fixtureChildMessage(response));
  const document = JSON.parse(response.stdout);
  assert.equal(document.status, 200, response.stdout);
  assert.equal(document.body.event.event_kind, 'shout');
  assert.equal(document.body.event.event_by, 'coordinator');
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_text, 'actual view action');
  assert.deepEqual(readFileSync(file), before, 'the authenticated view does not alter the local agent-session binding');
});

test('takeover waits for an active write and then refuses the old session [B3,B7]', { timeout: 45_000 }, async () => {
  const box = project();
  const started = join(box.dir, 'gate-started');
  const release = join(box.dir, 'gate-release');
  const gateFile = join(box.dir, 'holding-gate.cjs');
  writeFileSync(gateFile, `const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 10);
    setTimeout(() => process.exit(19), 20000).unref();
  `);
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: `node '${gateFile.replaceAll("'", "'\\''")}'` }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure holding gate');
  box.git(box.web, 'merge', '--quiet', 'main');
  const claim = box.run(box.web, ['claim', '1', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' });
  assert.equal(claim.status, 0, claim.stdout + claim.stderr);
  writeFileSync(join(box.web, 'web/page.txt'), 'changed for the claimed item\n');
  box.git(box.web, 'add', 'web/page.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): change the page [G1]');
  /** Start a real CLI write with a durable closed-process observation. */
  function launch(session, ...args) {
    const command = process.execPath;
    const childArgs = [BIN, ...args, '--json'];
    const childEnv = { ...box.base, CODEX_SESSION_ID: session };
    const startedAt = performance.now();
    const child = spawn(command, childArgs, { cwd: box.web, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { output += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
      const failure = code === 0 && !signal && !spawnError ? null : reportFixtureChildFailure({ command, args: childArgs,
        status: code, signal, elapsedMs: performance.now() - startedAt, stderr, env: childEnv,
        detail: spawnError?.message ?? '' });
      resolveClose({ code, signal, output, stderr, failure });
    }));
    return child;
  }
  /** Wait on an actual private fixture observation, with an assertion if it never becomes true. */
  async function observed(predicate, label) {
    const deadline = Date.now() + 10_000;
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.ok(predicate(), label);
  }
  /** Observe the takeover waiting on this checkout's resource rather than depending on a sleep. */
  function queued() {
    return listResources({ scope: 'repo', root: box.repo }).some((resource) => resource.name.startsWith('checkout-session:') && resource.line.length > 0);
  }
  const submission = launch('active-write-273', 'submit', '1');
  let takeover;
  try {
    await observed(() => existsSync(started) || submission.exitCode !== null, 'the actual submission reaches its configured gate');
    assert.equal(submission.exitCode, null, 'the submission is still writing while the gate waits');
    takeover = launch('next-write-273', 'takeover');
    await observed(() => queued() || takeover.exitCode !== null, 'the takeover reaches the same checkout guard');
    assert.equal(takeover.exitCode, null, 'takeover waits until the old session finishes its active write');
    assert.equal(boardSnapshot(box.boardFile).shout.length, 0, 'takeover has not recorded a receipt before acquiring the checkout');
    writeFileSync(release, 'release');
    const submitted = await submission.closed;
    assert.equal(submitted.code, 0, submitted.failure ?? submitted.output);
    const taken = await takeover.closed;
    assert.equal(taken.code, 0, taken.failure ?? taken.output);
    assert.equal(boardSnapshot(box.boardFile).item[0].item_status, 'submitted');
    const beforeRefusal = boardSnapshot(box.boardFile);
    const old = box.run(box.web, ['shout', 'coordinator', 'old session cannot write', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' });
    assert.equal(old.status, 1);
    assert.equal(JSON.parse(old.stdout).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardSnapshot(box.boardFile), beforeRefusal);
  } finally {
    writeFileSync(release, 'release');
    if (submission.exitCode === null) submission.kill('SIGTERM');
    if (takeover?.exitCode === null) takeover.kill('SIGTERM');
    await submission.closed;
    if (takeover) await takeover.closed;
  }
});
