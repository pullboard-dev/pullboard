/** Checkout-session ownership and takeover behavior [B3,B7]. */
import assert from 'node:assert/strict';
import {
  startFixtureChild as spawn,
  fixtureChildMessage,
  reportFixtureChildFailure,
  runFixtureChild,
  runFixtureGit,
} from "../../tests/fixtures/child.js";
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listResources } from "../../../../packages/resources/index.js";
import { SSH_SHELL_MARKERS } from "../../../../packages/kernel/index.js";
import { runCliInProcess } from "../../tests/fixtures/process.js";
import { requireSessionIndependence } from "../../tests/fixtures/testkit.js";
import { waitForCondition } from "../../tests/fixtures/runner/holders.js";

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
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
  /** Run the actual CLI dispatch in process with an explicit agent session or markerless terminal. */
  function inProcess(cwd, args, { session, sessionKey = 'CLAUDE_CODE_SESSION_ID', agent = true, extra = {} } = {}) {
    const env = { ...base, ...extra };
    if (agent) {
      env.CLAUDECODE = '1';
      if (session !== undefined) env[sessionKey] = session;
    }
    return runCliInProcess(args, { cwd, env });
  }
  return { dir, base, git, inProcess };
}

/** Create the main checkout and one joined lane worktree with a private board. */
async function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await box.inProcess(repo, ['init'], { agent: false })).status, 0);
  writeFileSync(join(repo, 'pullboard.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'page.txt'), 'ready\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize session fixture');
  const added = (await box.inProcess(repo, ['add', 'web', 'fixture item', '--specs', 'G1', '--json'], { agent: false }));
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const web = join(box.dir, 'web-agent');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/session');
  const joined = (await box.inProcess(web, ['join', 'web', '--family', 'Fixture-Builder', '--route', 'strong'], { agent: false }));
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

test('a second session cannot write in the main checkout until takeover [B3,B7]', async () => {
  const box = await project();
  const first = 'claude-session-secret-first-273';
  const second = 'claude-session-secret-second-273';
  const initial = (await box.inProcess(box.repo, ['shout', 'web', 'first session owns main', '--json'], { session: first }));
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);
  const before = boardSnapshot(box.boardFile);
  const refused = (await box.inProcess(box.repo, ['shout', 'web', 'must not land', '--json'], { session: second }));
  assert.notEqual(refused.status, 0);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'NOT_YOUR_CHECKOUT');
  assert.match(error.message, /coordinator/u);
  assert.match(error.next, /git worktree add --detach/u);
  assert.match(error.next, /pullboard takeover/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'refusal leaves all board counts unchanged');
  const worktrees = box.git(box.repo, 'worktree', 'list', '--porcelain');
  for (const args of [['init'], ['worktree', 'web'], ['hooks'], ['spec', 'apply'], ['hook', 'pre-commit'], ['submit', '1']]) {
    const blocked = (await box.inProcess(box.repo, [...args, '--json'], { session: second }));
    assert.equal(blocked.status, 1, `${args.join(' ')} must refuse another session before side effects`);
    assert.equal(JSON.parse(blocked.stdout).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardSnapshot(box.boardFile), before, `${args.join(' ')} leaves every board row intact`);
    assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), worktrees, 'the wrong session cannot create a worktree first');
  }

  const takeover = (await box.inProcess(box.repo, ['takeover', '--json'], { session: second }));
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  const rows = boardSnapshot(box.boardFile);
  assert.ok(rows.event.slice(before.event.length).some(row => row.event_kind === 'shout' && row.event_by === 'coordinator'), 'takeover is recorded through an existing ordered shout event');
  assert.match(rows.shout.at(-1).shout_text, /coordinator \(Test Model\) took over/);
  assert.equal(rows.shout.at(-1).shout_to, 'person');
  assert.equal(rows.shout.length, before.shout.length + 1, 'main-checkout takeover records the person notice');
  const after = (await box.inProcess(box.repo, ['shout', 'web', 'second session owns main', '--json'], { session: second }));
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assertNoRawSession(box, box.repo, [first, second]);
  const beforeSelf = boardSnapshot(box.boardFile);
  const self = (await box.inProcess(box.repo, ['shout', 'coordinator', 'cannot address myself', '--json'], { agent: false }));
  assert.notEqual(self.status, 0);
  assert.deepEqual(boardSnapshot(box.boardFile), beforeSelf, 'self-addressed shout is refused without changing the board');
});

test('lane ownership is session-scoped and takeover preserves the joined agent [B3,B7]', async () => {
  const box = await project();
  const first = 'codex-thread-secret-first-273';
  const second = 'codex-thread-secret-second-273';
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: first, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(claim.status, 0, `${claim.stdout}${claim.stderr}`);
  const sameSession = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: first, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(sameSession.status, 0, `${sameSession.stdout}${sameSession.stderr}`);
  const before = boardSnapshot(box.boardFile);
  const refused = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' }));
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, 'NOT_YOUR_CHECKOUT');
  assert.match(JSON.parse(refused.stdout).error.message, /web-1/u);
  assert.match(JSON.parse(refused.stdout).error.next, /git worktree add --detach/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'refused lane write leaves event and item counts unchanged');

  const takeover = (await box.inProcess(box.web, ['takeover', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
  assert.equal(boardSnapshot(box.boardFile).event.length, before.event.length + 1, 'lane takeover records one event');
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_to, 'coordinator');
  const after = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: second, sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  assertNoRawSession(box, box.web, [first, second], 'CODEX_THREAD_ID');
});

test('no-session shells are one session and markerless terminals retain their writes [B3,B7]', async () => {
  const box = await project();
  const sentinel = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: undefined }));
  assert.equal(sentinel.status, 0, `${sentinel.stdout}${sentinel.stderr}`);
  const noSessionAgain = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: undefined }));
  assert.equal(noSessionAgain.status, 0, `${noSessionAgain.stdout}${noSessionAgain.stderr}`);
  const terminalRead = (await box.inProcess(box.web, ['show', '1', '--json'], { agent: false }));
  assert.equal(terminalRead.status, 0, `${terminalRead.stdout}${terminalRead.stderr}`);
  assert.equal(JSON.parse(terminalRead.stdout).item_status, 'claimed');
  const beforeIdentified = boardSnapshot(box.boardFile);
  const identified = (await box.inProcess(box.web, ['release', '1', '--reason', 'BLOCKED', '--json'], { session: 'identified-after-sentinel-273', sessionKey: 'CODEX_SESSION_ID' }));
  assert.equal(identified.status, 1);
  assert.equal(JSON.parse(identified.stdout).error.code, 'NOT_YOUR_CHECKOUT');
  assert.deepEqual(boardSnapshot(box.boardFile), beforeIdentified);
  const terminalWrite = (await box.inProcess(box.web, ['shout', 'all', 'the markerless terminal still works', '--json'], { agent: false }));
  assert.equal(terminalWrite.status, 0, terminalWrite.stdout + terminalWrite.stderr);
  const secondSessionRead = (await box.inProcess(box.web, ['show', '1', '--json'], { session: 'read-from-another-session-273' }));
  assert.equal(secondSessionRead.status, 0, secondSessionRead.stdout + secondSessionRead.stderr);

  // Existing relay-person-request coverage should be retained: this private CLI fixture does not
  // establish a linked relay or inject io.personRequest, so an ordinary shout is not a substitute.
  // A decision addressed to its own sender must be refused rather than self-answered.
  const beforeSelf = boardSnapshot(box.boardFile);
  const self = (await box.inProcess(box.repo, ['shout', 'coordinator', 'self decision', '--decision', '--json'], { agent: false }));
  assert.notEqual(self.status, 0);
  assert.deepEqual(boardSnapshot(box.boardFile), beforeSelf, 'self-addressed decision is refused without a write');
});

test('a shout from the local view as the person is recorded as the person [N26,B26,B3,B7]', async () => {
  const box = await project();
  const owner = (await box.inProcess(box.repo, ['shout', 'web', 'agent owns this checkout', '--json'], { session: 'view-owner-session-273' }));
  assert.equal(owner.status, 0, owner.stdout + owner.stderr);
  assert.equal(boardSnapshot(box.boardFile).shout.at(-1).shout_from, 'coordinator', 'an agent-shell shout keeps the coordinator as author');
  const file = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const before = readFileSync(file);
  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/api/src/io/main.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { moveArgs, openBoard, openBoardForRead };
    const response = await executeMove(process.cwd(), { verb: 'shout', args: { to: 'web', text: 'actual view action' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    const asAgent = await executeMove(process.cwd(), { verb: 'shout', agent: 'web-1', args: { to: 'coordinator', text: 'Which path should web-1 use?', kind: 'question' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify({ ...response, asAgent }));
  `;
  const response = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: { ...box.base, CODEX_THREAD_ID: 'other-process-view-session-273' }, encoding: 'utf8',
  });
  assert.equal(response.status, 0, fixtureChildMessage(response));
  const document = JSON.parse(response.stdout);
  assert.equal(document.status, 200, response.stdout);
  assert.equal(document.body.event.event_kind, 'shout');
  assert.equal(document.body.event.event_by, 'person');
  const shouts = boardSnapshot(box.boardFile).shout;
  assert.equal(shouts.at(-2).shout_text, 'actual view action');
  assert.equal(shouts.at(-2).shout_from, 'person', 'the view as the coordinator records the person');
  assert.equal(document.asAgent.status, 200, response.stdout);
  assert.equal(shouts.at(-1).shout_from, 'web-1', 'the view acting as a named agent still records that agent');
  assert.deepEqual(readFileSync(file), before, 'the authenticated view does not alter the local agent-session binding');
});

test('takeover waits for an active write and then refuses the old session [B3,B7]', { timeout: 45_000 }, async () => {
  const box = await project();
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
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' }));
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
  /** Observe the takeover waiting for the active write: it holds the checkout and has written its intent. */
  function queued() {
    return existsSync(resolve(box.web, box.git(box.web, 'rev-parse', '--git-dir'), 'pullboard-checkout-takeover'))
      && listResources({ scope: 'repo', root: box.repo }).some((resource) => resource.name.startsWith('checkout-session:') && resource.holders.length > 0);
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
    const old = (await box.inProcess(box.web, ['shout', 'coordinator', 'old session cannot write', '--json'], { session: 'active-write-273', sessionKey: 'CODEX_SESSION_ID' }));
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

test('a remote shell is recognized by any SSH marker [B26,E22]', async () => {
  const box = await project();
  for (const key of SSH_SHELL_MARKERS) delete box.base[key];
  writeFileSync(join(box.repo, 'SPEC.md'), `${SPEC}- G2 [draft, must] A probe row for person moves. | gate: true\n`);
  box.git(box.repo, 'commit', '-qam', 'docs: draft a probe row');
  const markers = {
    SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22',
    SSH_CLIENT: '192.0.2.10 12345 22',
    SSH_TTY: '/dev/pts/7',
  };
  const shells = [...Object.entries(markers).map(([key, value]) => ({ [key]: value })), markers];
  const before = boardSnapshot(box.boardFile);
  for (const extra of shells) {
    const label = Object.keys(extra).join('+');
    const refused = (await box.inProcess(box.repo, ['spec', 'approve', 'G2', '--json'], { agent: false, extra }));
    assert.equal(refused.status, 1, `${label}: ${refused.stdout}${refused.stderr}`);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'B26_PERSON_CHANNEL', `${label} gives the person-channel refusal`);
    assert.match(error.message, /remote SSH shell/u, `${label} is named as a remote shell`);
    assert.match(error.next, /pullboard view/u, `${label} points the person at the view`);
    assert.deepEqual(boardSnapshot(box.boardFile), before, `${label} records no person decision`);
  }
  const local = (await box.inProcess(box.repo, ['spec', 'approve', 'G2', '--json'], { agent: false }));
  assert.equal(local.status, 0, `no SSH marker allows the person move: ${local.stdout}${local.stderr}`);

  box.git(box.repo, 'remote', 'add', 'origin', 'https://github.com/example/session-fixture.git');
  const relay = (await box.inProcess(box.repo, ['relay', 'on', '--url', 'http://127.0.0.1:9', '--json'], { agent: false, extra: { SSH_CLIENT: markers.SSH_CLIENT } }));
  const relayError = JSON.parse(relay.stdout || '{}').error;
  assert.notEqual(relayError?.code, 'B26_PERSON_CHANNEL', `relay on over SSH keeps its own channel: ${relay.stdout}${relay.stderr}`);
  assert.equal(relayError?.code, 'RELAY_UNAVAILABLE', 'relay on over SSH reaches the relay');
  assert.match(relayError.message, /\/auth\/device\/start/u, 'relay on over SSH starts its device sign-in (#615)');
});

/** Submit's detached review comparison writes its own fact; a board snapshot is stable only once it has finished. */
async function waitForReviewComparison(box) {
  const jobs = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'review-comparisons');
  const finished = () => existsSync(jobs) && readdirSync(jobs).some((job) => existsSync(join(jobs, job, 'result.json')));
  await waitForCondition(finished, 'the submitted item\'s review comparison finishes',
    { signal: AbortSignal.timeout(60_000), state: () => existsSync(jobs) ? readdirSync(jobs) : 'no comparison jobs' });
}

test('review.independence session: a verdict from the agent session that built the item is refused under any seat [V1,B3]', { timeout: 120_000 }, async () => {
  const box = await project();
  const builder = 'codex-thread-secret-builder-921';
  const build = (args) => box.inProcess(box.web, args, { session: builder, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal((await build(['claim', '1', '--json'])).status, 0);
  writeFileSync(join(box.web, 'web', 'page.txt'), 'built\n');
  box.git(box.web, 'commit', '-qam', 'feat(web): build the fixture item [G1]');
  const submitted = await build(['submit', '1', '--json']);
  assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);
  await waitForReviewComparison(box);
  // The same session opens a review seat of its own: a different seat name, the same session.
  const review = join(box.dir, 'review-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, box.git(box.web, 'rev-parse', 'HEAD'));
  requireSessionIndependence(review);
  const reviewAs = (session, args) => box.inProcess(review, args, { session, sessionKey: 'CODEX_THREAD_ID' });
  assert.equal((await reviewAs(builder, ['join', 'web', '--family', 'Fixture-Reviewer', '--route', 'strong', '--json'])).status, 0);
  const before = boardSnapshot(box.boardFile);
  const own = await reviewAs(builder, ['verify', '1', 'accept', '--note', 'checked the page', '--json']);
  assert.notEqual(own.status, 0, 'the building session cannot accept its own item from another seat');
  const error = JSON.parse(own.stdout).error;
  assert.equal(error.code, 'SELF_SESSION_VERIFY');
  assert.match(error.message, /this agent session built or submitted #1/u);
  assert.match(error.next, /start the review in a separate process or session: run pullboard next --verify from a different agent session/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'the refused verdict records nothing');
  assertNoRawSession(box, box.web, [builder], 'CODEX_THREAD_ID');
  const ledger = readFileSync(resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'item-sessions.jsonl'), 'utf8');
  assert.equal(ledger.includes(builder), false, 'the local item ledger keeps only the session digest');
  // Another session takes over that review seat and gives the verdict.
  const other = 'codex-thread-secret-reviewer-921';
  assert.equal((await reviewAs(other, ['takeover', '--json'])).status, 0);
  const accepted = await reviewAs(other, ['verify', '1', 'accept', '--note', 'checked the page', '--json']);
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
});

test('a session whose claims cannot be recorded is refused before it moves, never let through [V1,B3]', async () => {
  const box = await project();
  const ledger = resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'item-sessions.jsonl');
  writeFileSync(ledger, '', { mode: 0o400 });
  chmodSync(ledger, 0o400);
  const before = boardSnapshot(box.boardFile);
  const claim = (await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'codex-thread-secret-unrecorded-921', sessionKey: 'CODEX_THREAD_ID' }));
  assert.notEqual(claim.status, 0, 'an unrecordable claim is refused');
  const error = JSON.parse(claim.stdout).error;
  assert.equal(error.code, 'SESSION_LEDGER');
  assert.match(error.next, /chmod u\+rw/u);
  assert.deepEqual(boardSnapshot(box.boardFile), before, 'the refused claim moved nothing');
  chmodSync(ledger, 0o600);
  assert.equal((await box.inProcess(box.web, ['claim', '1', '--json'], { session: 'codex-thread-secret-unrecorded-921', sessionKey: 'CODEX_THREAD_ID' })).status, 0, 'a writable ledger lets it through');
  assert.match(readFileSync(ledger, 'utf8'), /"move":"claim"/u);
});

/** Open a helper seat from the web seat inside an agent session, returning the CLI result and the helper's Git directory. */
async function openHelper(box, session, { agent = true, from = box.web } = {}) {
  const made = (await box.inProcess(from, ['worktree', 'web', '--model', 'Helper Model', '--json'], { session, sessionKey: 'CODEX_THREAD_ID', agent }));
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  const result = JSON.parse(made.stdout);
  const gitDir = resolve(result.path, box.git(result.path, 'rev-parse', '--git-dir'));
  return { result, gitDir, file: join(gitDir, 'pullboard-parent-session.json') };
}

test('a helper seat records the agent that opened it [N2,B13]', async () => {
  const box = await project();
  const parent = JSON.parse((await box.inProcess(box.web, ['whoami', '--json'], { agent: false })).stdout).id;
  const session = 'codex-thread-secret-parent-800';
  const helper = await openHelper(box, session);
  assert.equal(existsSync(helper.file), true, 'opening the seat inside an agent session records its parent with no flag');
  const record = JSON.parse(readFileSync(helper.file, 'utf8'));
  assert.equal(record.parent, parent, 'the record names the agent that opened the seat');
  assert.equal(record.digest, createHash('sha256').update(JSON.stringify(['CODEX_THREAD_ID', session])).digest('hex'));
  assert.equal(readFileSync(helper.file, 'utf8').includes(session), false, 'the record keeps only the session digest');
  const lone = await openHelper(box, undefined, { agent: false });
  assert.equal(existsSync(lone.file), false, 'a seat a person opens has no parent');
  // The link never borrows a claim: the helper claims as itself, and the parent holds nothing.
  const claimed = (await box.inProcess(helper.result.path, ['claim', '1', '--json'], { session: 'codex-thread-secret-helper-800', sessionKey: 'CODEX_THREAD_ID' }));
  assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
  assert.equal(JSON.parse((await box.inProcess(box.web, ['show', '1', '--json'], { agent: false })).stdout).item_owner, helper.result.agent);
});

test('agents lists each agent with its helpers [N2,B13]', async () => {
  const box = await project();
  const parent = JSON.parse((await box.inProcess(box.web, ['whoami', '--json'], { agent: false })).stdout).id;
  const helper = await openHelper(box, 'codex-thread-secret-parent-800');
  assert.equal((await box.inProcess(helper.result.path, ['claim', '1', '--json'], { session: 'codex-thread-secret-helper-800', sessionKey: 'CODEX_THREAD_ID' })).status, 0);
  const listed = (await box.inProcess(box.web, ['agents', '--json'], { agent: false }));
  assert.equal(listed.status, 0, `${listed.stdout}${listed.stderr}`);
  const agents = JSON.parse(listed.stdout).agents;
  const top = agents.find((agent) => agent.id === parent);
  assert.ok(top, 'the opening agent is listed');
  assert.deepEqual(top.helpers.map((agent) => agent.id), [helper.result.agent], 'its helper is listed under it');
  assert.deepEqual(top.helpers[0].holds.map((hold) => hold.item), [1], 'the helper shows what it holds');
  assert.deepEqual(top.holds, [], 'the parent holds nothing the helper claimed');
  assert.equal(agents.some((agent) => agent.id === helper.result.agent), false, 'a helper is listed only under its parent');
  const text = (await box.inProcess(box.web, ['agents'], { agent: false }));
  assert.equal(text.status, 0);
  assert.match(text.stdout, new RegExp(`${helper.result.agent}[^\\n]*#1`, 'u'), 'the text view shows the helper and its item');
});

test('agents gives the coordinator a row with the helpers it opened [N2,B13]', async () => {
  const box = await project();
  const helper = await openHelper(box, 'codex-thread-coordinator-800', { from: box.repo });
  assert.equal(JSON.parse(readFileSync(helper.file, 'utf8')).parent, 'coordinator', 'the main checkout is recorded as the parent');
  const listed = JSON.parse((await box.inProcess(box.repo, ['agents', '--json'], { agent: false })).stdout).agents;
  const top = listed.find((agent) => agent.id === 'coordinator');
  assert.ok(top, 'the coordinator has its own row');
  assert.deepEqual(top.helpers.map((agent) => agent.id), [helper.result.agent], 'its helper is nested under it');
  assert.equal(listed.some((agent) => agent.id === helper.result.agent), false, 'the helper is not a top-level agent');
  const lines = (await box.inProcess(box.repo, ['agents'], { agent: false })).stdout.split(/\r?\n/u);
  const at = lines.findIndex((line) => line.startsWith('coordinator'));
  assert.ok(at >= 0, 'the text view has a coordinator line');
  assert.match(lines[at + 1] ?? '', new RegExp(`^ {2}\\S.*${helper.result.agent}|^ {2}.*\\(web lane\\)`, 'u'), 'the helper is indented under it');
});
