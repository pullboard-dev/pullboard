/** @pullboard-test-input apps/cli/pullboard.js apps/lib/src/io/check/baseline.js */
/** Coordinator-owned check commands and explicit caller consent [V2,N23]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from '../../tests/fixtures/child.js';
import { startFixtureChild as spawn } from '../../tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { addItem } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { validateItemAddition } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { prepareCheckBaseline } from '../../../../packages/gate/src/io/check/baseline.js';
import { removeFixtureDirectory } from '../../../../packages/gate/tests/fixtures/diagnostics.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const BASELINE_WORKER = resolve(import.meta.dirname, '../../../lib/src/io/check/baseline.js');
const TEMP_DIRS = [];
const BACKGROUND_WRITERS = [];
const SPEC = `# Check ownership fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;

/** Wait for every owned baseline worker before removing its fixture repository. */
async function cleanupFixtures() {
  const failures = [];
  for (const writer of BACKGROUND_WRITERS) writeFileSync(writer.releaseFile, 'release');
  for (const writer of BACKGROUND_WRITERS) {
    try {
      await writer.closed;
      assert.notEqual(writer.child.exitCode, null, `background writer ${writer.name} did not exit before cleanup`);
      assert.equal(writer.child.signalCode, null, `background writer ${writer.name} was signaled before cleanup`);
      assert.equal(writer.child.exitCode, 0, `background writer ${writer.name} exited unsuccessfully before cleanup`);
      assert.equal(readFileSync(writer.completedFile, 'utf8'), writer.completedValue,
        `background writer ${writer.name} wrote its late marker before cleanup`);
    } catch (error) { failures.push(error); }
  }
  for (const writer of BACKGROUND_WRITERS) if (writer.child.exitCode === null) await writer.closed;
  for (const dir of TEMP_DIRS) removeFixtureDirectory(dir);
  if (failures.length) throw failures[0];
}

after(cleanupFixtures);

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
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  /** Run Git with private fixture identity and config. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the production CLI in this process, optionally with piped stdin. */
  const run = (cwd, args, input) => runCliInProcess(args, { cwd, env, ...(input === undefined ? {} : { input }) });
  return { dir, env, git, local: run };
}

/** Initialize the board and register a real worktree joined to the web lane. */
async function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = await box.local(repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  // Baseline --wait needs a registered runner; the isolated machine home starts without one.
  const worker = join(box.dir, 'worker');
  const remoteHome = join(box.dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [worker, remoteHome, remoteMachineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin: join(box.dir, 'bin'), worker, home: remoteHome, machineHome: remoteMachineHome,
    requests: join(box.dir, 'ssh-requests.jsonl') });
  const registered = await box.local(repo, ['runner', 'add', HOST, '--slots', '1', '--browser', '0', '--json']);
  assert.equal(registered.status, 0, registered.stderr);
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
  const joined = await box.local(web, ['join', 'web']);
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
async function addCheckedItem(box, title, command) {
  const result = await box.local(box.repo, ['add', 'coordinator', title, '--check', command, '--wait', '--json']);
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
  const box = await project();
  const itemCountBefore = queryBoard(box, 'SELECT COUNT(*) AS count FROM item').count;
  const eventCountBefore = queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count;
  const forbiddenCreate = await box.local(box.web, ['add', 'web', 'Agent supplied check', '--check', 'true', '--json']);
  assert.equal(forbiddenCreate.status, 1, forbiddenCreate.stderr);
  assert.equal(JSON.parse(forbiddenCreate.stdout).error.code, 'COORDINATOR_CHECK');
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM item').count, itemCountBefore, 'refusal adds no item');
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count, eventCountBefore, 'refusal adds no event');

  const ordinary = await box.local(box.web, ['add', 'web', 'Agent ordinary item', '--json']);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const ordinaryId = JSON.parse(ordinary.stdout).item.item_id;
  const rowBefore = queryBoard(box, 'SELECT item_title, item_check, item_updated_at FROM item WHERE item_id = ?', ordinaryId);
  const eventsBeforeEdit = queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count;
  const forbiddenEdit = await box.local(box.web, ['edit', String(ordinaryId), '--check', 'true', '--json']);
  assert.equal(forbiddenEdit.status, 1, forbiddenEdit.stderr);
  assert.equal(JSON.parse(forbiddenEdit.stdout).error.code, 'COORDINATOR_CHECK');
  assert.deepEqual(queryBoard(box, 'SELECT item_title, item_check, item_updated_at FROM item WHERE item_id = ?', ordinaryId), rowBefore);
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count, eventsBeforeEdit, 'refused edit changes no event');

  for (const args of [
    ['add', 'web', 'Empty agent check', '--check', '', '--json'],
    ['edit', String(ordinaryId), '--check', '', '--json'],
  ]) {
    const refused = await box.local(box.web, args);
    assert.equal(refused.status, 1, 'explicitly setting or clearing an empty check also belongs to the coordinator');
    assert.equal(JSON.parse(refused.stdout).error.code, 'COORDINATOR_CHECK');
  }

  const coordinatorCommand = markerCheck('check-ran-coordinator.txt');
  const coordinatorId = await addCheckedItem(box, 'Coordinator check', coordinatorCommand);
  const coordinatorResult = await box.local(box.repo, ['check', String(coordinatorId)]);
  assert.equal(coordinatorResult.status, 0, coordinatorResult.stderr);
  assert.match(coordinatorResult.stdout, /set by coordinator/iu, 'even the setter sees the command attribution');
  assert.ok(coordinatorResult.stdout.includes(coordinatorCommand), 'the exact command is printed before execution');
  assert.doesNotMatch(coordinatorResult.stderr, /Run this check/iu, 'the setter needs no consent prompt');
  assert.equal(readFileSync(join(box.repo, 'check-ran-coordinator.txt'), 'utf8'), 'ran');

  const interactiveCommand = markerCheck('check-ran-interactive.txt');
  const interactiveId = ordinaryId;
  const authored = await box.local(box.repo, ['edit', String(interactiveId), '--check', interactiveCommand, '--wait', '--json']);
  assert.equal(authored.status, 0, authored.stdout + authored.stderr);
  assert.equal(queryBoard(box, 'SELECT item_created_by FROM item WHERE item_id = ?', interactiveId).item_created_by, 'web-1',
    'the check setter is derived from the edit, independently of the item creator');
  const eofRefusal = await box.local(box.web, ['check', String(interactiveId), '--json'], '');
  assert.equal(eofRefusal.status, 1, eofRefusal.stderr);
  assert.equal(JSON.parse(eofRefusal.stdout).error.code, 'CHECK_CONFIRM');
  assert.ok(eofRefusal.stderr.includes(interactiveCommand), 'JSON mode prints the exact command before requesting consent');
  assert.match(eofRefusal.stderr, /set by coordinator[\s\S]*Run this check\?/u);
  const interactiveMarker = join(box.web, 'check-ran-interactive.txt');
  assert.equal(existsSync(interactiveMarker), false,
    'EOF refusal runs no check command');
  const declined = await box.local(box.web, ['check', String(interactiveId), '--json'], 'no\n');
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
  const yesId = await addCheckedItem(box, 'Confirmed by flag', yesCommand);
  const yesResult = await box.local(box.web, ['check', String(yesId), '--yes', '--json']);
  assert.equal(yesResult.status, 0, yesResult.stderr);
  assert.equal(JSON.parse(yesResult.stdout).by, 'coordinator', 'JSON retains check attribution');
  assert.equal(JSON.parse(yesResult.stdout).check, yesCommand);
  assert.equal(readFileSync(join(box.web, 'check-ran-yes.txt'), 'utf8'), 'ran');
});

/** Wait for a real baseline worker to start its held check before the test body ends. */
async function waitForFile(filename, child, description) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filename) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.ok(existsSync(filename), `${description}${child.fixtureFailure ? `: ${child.fixtureFailure}` : ''}`);
}

test('check cleanup waits for every background writer [C7]', async () => {
  const box = await project();
  const startedFile = join(box.dir, 'baseline-started');
  const releaseFile = join(box.dir, 'baseline-release');
  const completedFile = join(box.dir, 'baseline-completed');
  const completedValue = 'late baseline write completed';
  const source = [
    `const fs = require('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');`,
    `while (!fs.existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `fs.writeFileSync(${JSON.stringify(completedFile)}, ${JSON.stringify(completedValue)});`,
  ].join('');
  const command = `${shellWord(process.execPath)} -e ${shellWord(source)}`;
  const baseline = prepareCheckBaseline(box.repo, command);
  assert.equal(baseline.result, 'pending', 'the real fixture check starts with an authorized pending baseline');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let itemId;
  try {
    itemId = addItem(board, {
      by: 'coordinator', lane: 'web', title: 'Held baseline writer',
      criterion: 'cleanup waits until the baseline worker exits', check: command, checkBaseline: baseline,
    });
  } finally { closeBoard(board); }

  const child = spawn(process.execPath, [BASELINE_WORKER, box.repo, String(itemId), baseline.request], {
    cwd: box.repo, env: box.env, stdio: 'ignore',
  });
  const closed = new Promise(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  BACKGROUND_WRITERS.push({
    name: `baseline request ${baseline.request}`,
    child,
    releaseFile,
    completedFile,
    completedValue,
    closed,
  });
  await waitForFile(startedFile, child, `background writer ${baseline.request} started its check`);
  assert.equal(existsSync(completedFile), false, 'the baseline is still writing after the test body reaches cleanup');
});

test('a check that pipes its proof into tail is refused [C7,V4]', () => {
  const board = openBoard(':memory:');
  try {
    const masked = { by: 'coordinator', lane: 'core', title: 'Masked proof', criterion: 'the proof passes', route: 'strong', check: `${shellWord(process.execPath)} -e "process.exit(1)" | tail -5` };
    assert.throws(() => validateItemAddition(board, masked), (error) => error.code === 'CHECK_MASKS_EXIT'
      && /pipes its proof into tail/u.test(error.message) && /pipefail/u.test(error.message));
  } finally { closeBoard(board); }
});

test('a captured-output check is accepted [C7,V4]', () => {
  const board = openBoard(':memory:');
  try {
    const captured = `out=$(${shellWord(process.execPath)} -e "process.exit(1)"); printf '%s\\n' "$out" | grep -Eq 'never'`;
    assert.doesNotThrow(() => validateItemAddition(board, { by: 'coordinator', lane: 'core', title: 'Captured proof', criterion: 'the proof passes', route: 'strong', check: captured }));
  } finally { closeBoard(board); }
});

/** Return the refusal code a check gets from the same validator add and edit use, or null when it passes [C7,V4]. */
function maskRefusal(check) {
  const board = openBoard(':memory:');
  try {
    validateItemAddition(board, { by: 'coordinator', lane: 'core', title: 'Mask probe', criterion: 'the proof passes', route: 'strong', check });
    return null;
  } catch (error) { return error.code; } finally { closeBoard(board); }
}

test('an uncaptured grep that decides the exit is refused [C7,V4]', () => {
  assert.equal(maskRefusal('node -e "process.exit(1)" | grep -q x'), 'CHECK_MASKS_EXIT');
});

test('a pipe into xargs that hides the exit is refused [C7,V4]', () => {
  assert.equal(maskRefusal('node -e "process.exit(1)" | xargs echo'), 'CHECK_MASKS_EXIT');
});

test('a bare pipefail mention in an echo does not stop a masked pipe being refused [C7,V4]', () => {
  assert.equal(maskRefusal('echo pipefail; node -e "process.exit(1)" | tail -5'), 'CHECK_MASKS_EXIT');
});

test('a check that sets pipefail as a command is accepted [C7,V4]', () => {
  assert.equal(maskRefusal('set -o pipefail; node -e "process.exit(1)" | tail -5'), null);
});

test('a pipe into tail inside a subshell or after an assignment is refused [C7,V4]', () => {
  const masked = `node -e "console.log('proof-red'); process.exit(7)" | tail -n1`;
  // A capture exempts only a pipeline that tests the captured value; this one is never read (#812 review).
  assert.equal(maskRefusal(`out=$(printf ok); ${masked}`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`name=value; ${masked}`), 'CHECK_MASKS_EXIT', 'after a plain assignment');
  // A ( ) subshell or { ; } group exits with its last stage, so its pipes count; only $( ) hides them (#812 review).
  assert.equal(maskRefusal(`(${masked})`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`{ ${masked}; }`), 'CHECK_MASKS_EXIT');
});

test("the board's own captured-output form is accepted [C7,V4]", () => {
  assert.equal(maskRefusal(`out=$(node apps/cli/src/io/run/tests.js test/x.test.js 2>&1); printf "%s\\n" "$out"; printf "%s\\n" "$out" | grep -Eq "^# fail 0$" && printf "%s\\n" "$out" | grep -Eq "ok"`), null);
  assert.equal(maskRefusal(`out=$(node -e "process.exit(1)" | tail -5); echo "$out" | grep -q ok`), null, 'a pipe inside the capture is not a check pipeline');
});

test('a check that turns pipefail off or sets it conditionally is refused [C7,V4]', () => {
  const masked = `node -e "console.log('proof-red'); process.exit(7)" | tail -n1`;
  // /bin/sh never runs this set, since false fails first, so the pipe still exits 0 (#812 review).
  assert.equal(maskRefusal(`false && set -o pipefail; ${masked}`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`set -o pipefail; set +o pipefail; ${masked}`), 'CHECK_MASKS_EXIT', 'a later set +o pipefail turns it off');
  assert.equal(maskRefusal(`(set -o pipefail); ${masked}`), 'CHECK_MASKS_EXIT', 'a subshell keeps its pipefail to itself');
  assert.equal(maskRefusal(`set -euo pipefail; set +eo pipefail; ${masked}`), 'CHECK_MASKS_EXIT', 'a set +o form that clears it');
  assert.equal(maskRefusal(`if true; then set -o pipefail; fi; ${masked}`), 'CHECK_MASKS_EXIT', 'a set inside an if is conditional');
  assert.equal(maskRefusal(`cd .; set -o pipefail; ${masked}`), 'CHECK_MASKS_EXIT', 'pipefail must be the first command');
  assert.equal(maskRefusal(`set -euo pipefail\n${masked}`), null, 'a first-command set that always runs keeps the producer exit');
});

test('a pipe inside a shell comment is not a pipeline [C7,V4]', () => {
  assert.equal(maskRefusal('printf proof-green # example only: false | tail'), null);
  assert.equal(maskRefusal('echo a#b | tail -n1'), 'CHECK_MASKS_EXIT', 'a # inside a word starts no comment');
});
