/** Coordinator-owned check commands and explicit caller consent [V2,N23]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { removeFixtureDirectory } from './cleanup-diagnostics.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP_DIRS = [];
const SPEC = `# Check ownership fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;

after(() => {
  for (const dir of TEMP_DIRS) removeFixtureDirectory(dir);
});

/** Quote a literal executable path for the fixture hook's POSIX shim. */
function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Create an isolated Git fixture with a real CLI process runner. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-check-owner-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Check owner test',
    GIT_AUTHOR_EMAIL: 'check-owner@example.invalid',
    GIT_COMMITTER_NAME: 'Check owner test',
    GIT_COMMITTER_EMAIL: 'check-owner@example.invalid',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
  };
  /** Run Git with private fixture identity and config. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the production CLI in a separate process, optionally with piped stdin. */
  const run = (cwd, args, input) => runFixtureChild(process.execPath, [BIN, ...args], {
    cwd, env, encoding: 'utf8', ...(input === undefined ? {} : { input }),
  });
  return { dir, env, git, run };
}

/** Initialize the board and register a real worktree joined to the web lane. */
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
  box.git(repo, 'commit', '-q', '-m', 'chore: set up check ownership fixture');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = box.run(web, ['join', 'web']);
  assert.equal(joined.status, 0, joined.stderr);
  return { ...box, repo, web };
}

/** Open the actual board database read-only and run one scalar query. */
function queryBoard(box, sql, ...params) {
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

/** Build a harmless project check that writes a distinct marker in its cwd. */
function markerCheck(filename) {
  const source = `require('node:fs').writeFileSync(${JSON.stringify(filename)}, 'ran')`;
  return `${shellWord(process.execPath)} -e ${shellWord(source)}`;
}

/** Add a check-bearing item as the coordinator and return its persisted id. */
function addCheckedItem(box, title, command) {
  const result = box.run(box.repo, ['add', 'coordinator', title, '--check', command, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

/** Prompt the spawned agent CLI only after capturing its setter and exact command text. */
async function confirmInteractively(box, itemId, command, markerFile, json = false) {
  const child = spawn(process.execPath, [BIN, 'check', String(itemId), ...(json ? ['--json'] : [])], {
    cwd: box.web,
    env: box.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let sent = false;
  let promptResolve;
  let promptReject;
  const prompt = new Promise((resolvePrompt, rejectPrompt) => {
    promptResolve = resolvePrompt;
    promptReject = rejectPrompt;
  });
  /** Send consent only after both the command attribution and its question are visible. */
  function answerPrompt() {
    const notice = json ? stderr : stdout;
    if (sent || !/set by coordinator/iu.test(notice) || !notice.includes(command) || !/Run this check\?/u.test(stderr)) return;
    sent = true;
    try {
      assert.equal(existsSync(markerFile), false, 'the check has not run before the setter, command and consent question are displayed');
      promptResolve();
      child.stdin.end('yes\n');
    } catch (error) { promptReject(error); child.kill('SIGKILL'); }
  }
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; answerPrompt(); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; answerPrompt(); });
  child.once('error', promptReject);
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('close', (code, signal) => {
      if (!sent) promptReject(new Error(child.fixtureFailure ?? 'check exited before its prompt'));
      resolveClose({ code, signal, failure: child.fixtureFailure });
    });
    child.once('error', rejectClose);
  });
  try {
    await prompt;
    const result = await closed;
    assert.equal(result.signal, null);
    return { ...result, stdout, stderr };
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.race([closed, new Promise((resolveClose) => setTimeout(resolveClose, 1_000))]);
    throw error;
  }
}

test('[V2,N23] only the coordinator sets checks and agents confirm them before execution', async () => {
  const box = project();
  const itemCountBefore = queryBoard(box, 'SELECT COUNT(*) AS count FROM item').count;
  const eventCountBefore = queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count;
  const forbiddenCreate = box.run(box.web, ['add', 'web', 'Agent supplied check', '--check', 'true', '--json']);
  assert.equal(forbiddenCreate.status, 1, forbiddenCreate.stderr);
  assert.equal(JSON.parse(forbiddenCreate.stdout).error.code, 'COORDINATOR_CHECK');
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM item').count, itemCountBefore, 'refusal adds no item');
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count, eventCountBefore, 'refusal adds no event');

  const ordinary = box.run(box.web, ['add', 'web', 'Agent ordinary item', '--json']);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const ordinaryId = JSON.parse(ordinary.stdout).item.item_id;
  const rowBefore = queryBoard(box, 'SELECT item_title, item_check, item_updated_at FROM item WHERE item_id = ?', ordinaryId);
  const eventsBeforeEdit = queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count;
  const forbiddenEdit = box.run(box.web, ['edit', String(ordinaryId), '--check', 'true', '--json']);
  assert.equal(forbiddenEdit.status, 1, forbiddenEdit.stderr);
  assert.equal(JSON.parse(forbiddenEdit.stdout).error.code, 'COORDINATOR_CHECK');
  assert.deepEqual(queryBoard(box, 'SELECT item_title, item_check, item_updated_at FROM item WHERE item_id = ?', ordinaryId), rowBefore);
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count, eventsBeforeEdit, 'refused edit changes no event');

  for (const args of [
    ['add', 'web', 'Empty agent check', '--check', '', '--json'],
    ['edit', String(ordinaryId), '--check', '', '--json'],
  ]) {
    const refused = box.run(box.web, args);
    assert.equal(refused.status, 1, 'explicitly setting or clearing an empty check also belongs to the coordinator');
    assert.equal(JSON.parse(refused.stdout).error.code, 'COORDINATOR_CHECK');
  }

  const coordinatorCommand = markerCheck('check-ran-coordinator.txt');
  const coordinatorId = addCheckedItem(box, 'Coordinator check', coordinatorCommand);
  const coordinatorResult = box.run(box.repo, ['check', String(coordinatorId)]);
  assert.equal(coordinatorResult.status, 0, coordinatorResult.stderr);
  assert.match(coordinatorResult.stdout, /set by coordinator/iu, 'even the setter sees the command attribution');
  assert.ok(coordinatorResult.stdout.includes(coordinatorCommand), 'the exact command is printed before execution');
  assert.doesNotMatch(coordinatorResult.stderr, /Run this check/iu, 'the setter needs no consent prompt');
  assert.equal(readFileSync(join(box.repo, 'check-ran-coordinator.txt'), 'utf8'), 'ran');

  const interactiveCommand = markerCheck('check-ran-interactive.txt');
  const interactiveId = ordinaryId;
  const authored = box.run(box.repo, ['edit', String(interactiveId), '--check', interactiveCommand, '--json']);
  assert.equal(authored.status, 0, authored.stdout + authored.stderr);
  assert.equal(queryBoard(box, 'SELECT item_created_by FROM item WHERE item_id = ?', interactiveId).item_created_by, 'web-1',
    'the check setter is derived from the edit, independently of the item creator');
  const eofRefusal = box.run(box.web, ['check', String(interactiveId), '--json'], '');
  assert.equal(eofRefusal.status, 1, eofRefusal.stderr);
  assert.equal(JSON.parse(eofRefusal.stdout).error.code, 'CHECK_CONFIRM');
  assert.ok(eofRefusal.stderr.includes(interactiveCommand), 'JSON mode prints the exact command before requesting consent');
  assert.match(eofRefusal.stderr, /set by coordinator[\s\S]*Run this check\?/u);
  const interactiveMarker = join(box.web, 'check-ran-interactive.txt');
  assert.equal(existsSync(interactiveMarker), false,
    'EOF refusal runs no check command');
  const declined = box.run(box.web, ['check', String(interactiveId), '--json'], 'no\n');
  assert.equal(declined.status, 1);
  assert.equal(JSON.parse(declined.stdout).error.code, 'CHECK_CONFIRM');
  assert.equal(existsSync(interactiveMarker), false, 'declining the prompt also executes no command');

  const confirmed = await confirmInteractively(box, interactiveId, interactiveCommand, interactiveMarker);
  assert.equal(confirmed.code, 0, `${confirmed.stdout}${confirmed.stderr}`);
  assert.match(confirmed.stdout, /set by coordinator/iu);
  assert.ok(confirmed.stdout.includes(interactiveCommand), 'the prompt shows the exact command before confirmation');
  assert.equal(readFileSync(interactiveMarker, 'utf8'), 'ran');

  rmSync(interactiveMarker);
  const jsonConfirmed = await confirmInteractively(box, interactiveId, interactiveCommand, interactiveMarker, true);
  assert.equal(jsonConfirmed.code, 0, jsonConfirmed.stderr);
  assert.equal(JSON.parse(jsonConfirmed.stdout).by, 'coordinator', 'JSON remains one document while consent notices print immediately on stderr');
  assert.equal(readFileSync(interactiveMarker, 'utf8'), 'ran');

  const yesCommand = markerCheck('check-ran-yes.txt');
  const yesId = addCheckedItem(box, 'Confirmed by flag', yesCommand);
  const yesResult = box.run(box.web, ['check', String(yesId), '--yes', '--json']);
  assert.equal(yesResult.status, 0, yesResult.stderr);
  assert.equal(JSON.parse(yesResult.stdout).by, 'coordinator', 'JSON retains check attribution');
  assert.equal(JSON.parse(yesResult.stdout).check, yesCommand);
  assert.equal(readFileSync(join(box.web, 'check-ran-yes.txt'), 'utf8'), 'ran');
});
