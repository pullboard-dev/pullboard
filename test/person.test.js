/** Person terminal identity and immutable channel receipts on real repositories [B26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { test } from 'node:test';
import { SSH_SHELL_MARKERS } from '../src/person.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  AI_AGENT: '1',
  CODEX_THREAD_ID: 'thread-fixture',
  CODEX_SESSION_ID: 'session-fixture',
  CODEX_CI: '1',
  CODEX_SHELL: '1',
};
const SPEC = `# Person answer fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;
const TEMP_DIRS = [];

/** Remove every recognized agent marker from an environment copy. */
function cleanEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(MARKERS)) delete env[key];
  for (const key of SSH_SHELL_MARKERS) delete env[key];
  return env;
}

/** Quote a literal executable path for the fixture hook's POSIX shim. */
function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Create an isolated Git environment and an actual CLI subprocess runner. */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-person-channel-')));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = cleanEnvironment({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Person channel test',
    GIT_AUTHOR_EMAIL: 'person-channel@example.invalid',
    GIT_COMMITTER_NAME: 'Person channel test',
    GIT_COMMITTER_EMAIL: 'person-channel@example.invalid',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
  });
  /** Run real Git commands under isolated author and configuration settings. */
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run the real Pullboard CLI in its own process with optional environment markers. */
  const run = (cwd, args, extraEnv = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000,
  });
  return { dir, env, git, run };
}

/** Initialize a real repository, configure its lane, and join a real worktree. */
function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = box.run(repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({
    ...config,
    gate: 'true',
    spec: 'SPEC.md',
    lanes: { web: { owns: ['web/'], specs: ['G1'] } },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up person channel fixture');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = box.run(web, ['join', 'web']);
  assert.equal(joined.status, 0, joined.stderr);
  return { ...box, repo, web };
}

/** Read persisted shout and event counts without opening or migrating the board. */
function boardCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      shouts: db.prepare('SELECT COUNT(*) AS count FROM shout').get().count,
      events: db.prepare('SELECT COUNT(*) AS count FROM event').get().count,
    };
  } finally {
    db.close();
  }
}

/** Return the private database event detail for the most recent answer. */
function lastAnswerDetail(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'answer' ORDER BY event_id DESC LIMIT 1").get();
    assert.ok(row, 'the successful person answer must append an answer event');
    return JSON.parse(row.event_detail);
  } finally {
    db.close();
  }
}

test('[B26] person answers refuse agent environments without writes and record terminal channel', (t) => {
  t.after(() => {
    for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
  });
  const box = project();
  const asked = box.run(box.web, ['shout', 'coordinator', 'Ship the patch?', '--decision']);
  assert.equal(asked.status, 0, asked.stderr);
  const askedId = /as #(\d+)/u.exec(asked.stdout)?.[1];
  assert.ok(askedId, asked.stdout);
  const passed = box.run(box.repo, ['pass', askedId, 'The person should decide.']);
  assert.equal(passed.status, 0, passed.stderr);
  const personId = /as #(\d+)/u.exec(passed.stdout)?.[1];
  assert.ok(personId, passed.stdout);

  const database = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const beforeRefusals = boardCounts(database);
  for (const [marker, value] of Object.entries(MARKERS)) {
    const refused = box.run(box.repo, ['answer', personId, 'Ship it.', '--as', 'person', '--json'], { [marker]: value });
    assert.equal(refused.status, 1, `${marker}: ${refused.stdout}${refused.stderr}`);
    assert.equal(refused.stderr, '', `${marker} refusal should be a single JSON document`);
    const document = JSON.parse(refused.stdout);
    assert.equal(document.error.code, 'B26_PERSON_CHANNEL', marker);
    assert.match(document.error.message, /view/iu, marker);
    assert.match(document.error.next, /pullboard view/iu, marker);
    assert.deepEqual(boardCounts(database), beforeRefusals, `${marker} must not append an answer or event`);
  }

  const terminal = box.run(box.repo, ['answer', personId, 'Ship it.', '--as', 'person', '--json'], cleanEnvironment(box.env));
  assert.equal(terminal.status, 0, terminal.stderr);
  const answer = JSON.parse(terminal.stdout);
  assert.equal(answer.version, 1);
  assert.equal(lastAnswerDetail(database).channel, 'terminal');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const replies = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'answer' AND event_by = 'person' ORDER BY event_id").all();
    assert.equal(replies.length, 2, 'both the person decision and its forwarded reply have receipts');
    assert.deepEqual(replies.map((row) => JSON.parse(row.event_detail).channel), ['terminal', 'terminal']);
  } finally { db.close(); }
});


/** Start the actual view in an agent environment and retain only its private request credentials. */
async function startView(t, box, extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], {
    cwd: box.repo, env: { ...box.env, ...MARKERS, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8').on('data', (part) => { diagnostics += part; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    let timer;
    await Promise.race([closed, new Promise((done) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
    })]);
    clearTimeout(timer);
  });
  const document = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('the private view did not start: ' + diagnostics)), 10_000);
    child.stdout.on('data', (part) => {
      output += part;
      try {
        const value = JSON.parse(output);
        clearTimeout(timer);
        ready(value);
      } catch { /* The JSON envelope may arrive in several chunks. */ }
    });
    child.once('error', (error) => { clearTimeout(timer); fail(error); });
    child.once('close', () => { clearTimeout(timer); fail(new Error('the private view exited: ' + diagnostics)); });
  });
  const address = new URL(document.url);
  const secret = address.searchParams.get('k');
  assert.ok(secret, 'the actual view starts with its private session credentials');
  /** Send bounded authenticated requests through the same adapter the view uses. */
  const request = (path, options = {}) => fetch(new URL(path, address.origin), {
    ...options, headers: { 'x-pullboard-key': secret, ...options.headers }, signal: AbortSignal.timeout(10_000),
  });
  return request;
}

test('[B26,B3] person actions over SSH refuse terminals while the authenticated view remains available', async (t) => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  /** Create a real person decision by passing a worktree agent's request. */
  const createPersonDecision = (text) => {
    const asked = box.run(box.web, ['shout', 'coordinator', text, '--decision', '--json']);
    assert.equal(asked.status, 0, asked.stderr);
    const passed = box.run(box.repo, ['pass', String(JSON.parse(asked.stdout).id), 'The person should decide.', '--json']);
    assert.equal(passed.status, 0, passed.stderr);
    return JSON.parse(passed.stdout).id;
  };
  const terminalPerson = createPersonDecision('Answer from a local terminal?');
  const viewPerson = createPersonDecision('Answer from the view over SSH?');
  const database = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = boardCounts(database);
  for (const remote of [
    { SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22' },
    { SSH_TTY: '/dev/pts/7' },
  ]) {
    const refused = box.run(box.repo, ['answer', String(terminalPerson), 'Ship it.', '--as', 'person', '--json'], remote);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'B26_PERSON_CHANNEL');
    assert.match(error.message, /remote SSH shell/iu);
    assert.match(error.next, /pullboard view/iu);
    assert.deepEqual(boardCounts(database), before, 'SSH refusals append no answer or event');
  }
  const local = box.run(box.repo, ['answer', String(terminalPerson), 'Ship it.', '--as', 'person', '--json'], cleanEnvironment(box.env));
  assert.equal(local.status, 0, local.stderr);
  assert.equal(lastAnswerDetail(database).channel, 'terminal');

  const request = await startView(t, box, { SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22', SSH_TTY: '/dev/pts/7' });
  const listing = await (await request('/api/v1/boards')).json();
  const board = listing.boards.find((entry) => entry.root === box.repo);
  assert.ok(board, 'view remains available when launched with SSH environment markers');
  const response = await request(`/api/v1/boards/${board.id}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'answer', item: viewPerson, agent: 'coordinator', args: { text: 'Yes.', as: 'person' } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const answer = await response.json();
  assert.equal(answer.event.event_by, 'person');
  assert.equal(JSON.parse(answer.event.event_detail).channel, 'view');
});

test('[B26,B27] a view launched by an agent records view on both person answer receipts', async (t) => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const asked = box.run(box.web, ['shout', 'coordinator', 'Ship from the view?', '--decision', '--json']);
  assert.equal(asked.status, 0, asked.stderr);
  const original = JSON.parse(asked.stdout).id;
  const passed = box.run(box.repo, ['pass', String(original), 'The person should decide.', '--json']);
  assert.equal(passed.status, 0, passed.stderr);
  const person = JSON.parse(passed.stdout).id;
  const request = await startView(t, box);
  const boards = await (await request('/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  assert.ok(board, 'the real initialized project is listed in the view');
  const path = `/api/v1/boards/${board.id}/moves`;
  const database = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = boardCounts(database);
  const forged = await request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'answer', item: person, agent: 'coordinator', args: { text: 'Yes.', as: 'person', channel: 'view' } }),
  });
  assert.equal(forged.status, 400, 'channel is adapter evidence, never a caller-supplied argument');
  assert.equal((await forged.json()).error.code, 'BAD_REQUEST');
  assert.deepEqual(boardCounts(database), before);
  const response = await request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'answer', item: person, agent: 'coordinator', args: { text: 'Yes.', as: 'person' } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const answer = await response.json();
  assert.equal(answer.event.event_by, 'person');
  assert.equal(JSON.parse(answer.event.event_detail).channel, 'view');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const receipts = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'answer' AND event_by = 'person' ORDER BY event_id").all();
    assert.equal(receipts.length, 2, 'the decision answer and its forwarded reply both remain recorded');
    assert.deepEqual(receipts.map((row) => JSON.parse(row.event_detail).channel), ['view', 'view']);
  } finally { db.close(); }
});


test('[B26,S5] an agent shell cannot append a person sign-off but a plain shell can', (t) => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/proof.test.js'), '/** Local board preservation evidence [G1]. */\n');
  box.git(box.repo, 'add', 'test/proof.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: cite board preservation [G1]');
  const file = join(box.repo, '.pullboard/signoffs.jsonl');
  const plain = box.run(box.repo, ['spec', 'signoff', 'G1', '--by', 'CO', '--json']);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.equal(JSON.parse(plain.stdout).count, 1);
  const original = readFileSync(file, 'utf8');
  for (const [name, value] of Object.entries(MARKERS)) {
    const refused = box.run(box.repo, ['spec', 'signoff', 'G1', '--by', 'CO', '--json'], { [name]: value });
    assert.equal(refused.status, 1, name + ': ' + refused.stdout + refused.stderr);
    const error = JSON.parse(refused.stdout).error;
    assert.equal(error.code, 'B26_PERSON_CHANNEL', name);
    const inspected = box.run(box.repo, ['decisions', '--as', 'person', '--json'], { [name]: value });
    assert.equal(inspected.status, 0, 'read-only inspection does not approve a person call');
    assert.match(error.next, /pullboard view/iu, name);
    assert.equal(readFileSync(file, 'utf8'), original, name + ' preserves every existing sign-off byte');
  }
});

test('[B26,S18] signer enrollment refuses agent shells without creating or changing trust files', (t) => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const key = join(box.dir, 'fixture-signing-key');
  const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: box.env, stdio: 'ignore' });
  assert.equal(generated.status, 0, 'the fixture creates a disposable signing identity');
  const files = ['signers', 'signers.initial', 'first-commit', 'signoffs.jsonl'].map(name => join(box.repo, '.pullboard', name));
  /** Read only private fixture trust bytes; assertions never print key contents. */
  const trustBytes = () => files.map(file => existsSync(file) ? readFileSync(file).toString('base64') : null);
  const absent = trustBytes();
  for (const [name, value] of Object.entries(MARKERS)) {
    const refused = box.run(box.repo, ['spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person', '--json'], { [name]: value });
    assert.equal(refused.status, 1, name);
    assert.equal(JSON.parse(refused.stdout).error.code, 'B26_PERSON_CHANNEL', name);
    assert.equal(JSON.stringify(trustBytes()) === JSON.stringify(absent), true, 'refused enrollment creates no trust files');
  }
  const plain = box.run(box.repo, ['spec', 'signers', 'add', '--key', key + '.pub', '--by', 'fixture-person', '--json']);
  assert.equal(plain.status, 0);
  assert.equal(JSON.parse(plain.stdout).added, true);
  const enrolled = trustBytes();
  for (const [name, value] of Object.entries(MARKERS)) {
    const refused = box.run(box.repo, ['spec', 'signers', 'add', '--key', key + '.pub', '--by', 'another-person', '--json'], { [name]: value });
    assert.equal(refused.status, 1, name);
    assert.equal(JSON.stringify(trustBytes()) === JSON.stringify(enrolled), true, 'refused enrollment preserves every trust byte');
  }
});


test('[B26,S19] row approvals and declines refuse agent shells and preserve terminal or view channels', async (t) => {
  const box = project();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  const file = join(box.repo, 'SPEC.md');
  const rows = ['G2', 'G3', 'G4', 'G5'].map((id) => `- ${id} [draft, aim] The person decides ${id}. | gate: review`).join('\n');
  writeFileSync(file, SPEC + rows + '\n');
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add draft person decision rows');
  const beforeFile = readFileSync(file, 'utf8');
  const database = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = boardCounts(database);
  for (const [marker, value] of Object.entries(MARKERS)) {
    for (const decision of ['approve', 'decline']) {
      const args = ['spec', decision, 'G2', '--json'];
      if (decision === 'decline') args.push('--reason', 'The person declines this draft.');
      const refused = box.run(box.repo, args, { [marker]: value });
      assert.equal(refused.status, 1, `${marker} ${decision}: ${refused.stdout}${refused.stderr}`);
      const error = JSON.parse(refused.stdout).error;
      assert.equal(error.code, 'B26_PERSON_CHANNEL');
      assert.match(error.next, /pullboard view/iu);
      assert.deepEqual(boardCounts(database), before, 'refused row decisions append no board events');
      assert.equal(readFileSync(file, 'utf8'), beforeFile, 'refused row decisions preserve the spec bytes');
    }
  }
  for (const [decision, id] of [['approve', 'G2'], ['decline', 'G3']]) {
    const args = ['spec', decision, id, '--json'];
    if (decision === 'decline') args.push('--reason', 'The person declines this draft.');
    const result = box.run(box.repo, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout).decisions[0];
    assert.equal(receipt.id, id);
    assert.equal(receipt.decision, decision);
  }
  const request = await startView(t, box);
  const listing = await (await request('/api/v1/boards')).json();
  const board = listing.boards.find((entry) => entry.root === box.repo);
  assert.ok(board);
  for (const [decision, id] of [['approve', 'G4'], ['decline', 'G5']]) {
    const args = { ids: id };
    if (decision === 'decline') args.reason = 'The person declines from the view.';
    const response = await request(`/api/v1/boards/${board.id}/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'spec-' + decision, args }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const document = await response.json();
    assert.equal(document.event.event_by, 'person');
    assert.equal(JSON.parse(document.event.event_detail).channel, 'view');
    assert.equal(document.result.decisions[0].id, id);
    assert.equal(document.result.decisions[0].decision, decision);
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const events = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'row_decision' ORDER BY event_id").all();
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => JSON.parse(event.event_detail).channel), ['terminal', 'terminal', 'view', 'view']);
  } finally { db.close(); }
  assert.equal(readFileSync(file, 'utf8'), beforeFile, 'approval receipts await coordinator apply; neither channel edits the row file');
});
