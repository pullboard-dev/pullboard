/** @pullboard-test-input apps/cli/pullboard.js apps/lib/src/io/check/baseline.js */
/** Coordinator-owned check commands and explicit caller consent [V2,N23]. */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from '../../tests/fixtures/child.js';
import { startFixtureChild as spawn } from '../../tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { test } from 'node:test';
import { closeBoard } from '../../../../packages/store/index.js';
import { validateItemAddition } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { project } from '../../tests/fixtures/check-owner.js';
import { removeSandboxes } from '../../tests/fixtures/check-owner.js';
import { shellWord } from '../../tests/fixtures/check-owner.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
after(removeSandboxes);

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

/** Add a check-bearing item as the coordinator and return its persisted id. The pulled baseline is not waited for: no case here reads it, and a waited add held 120 s for the stand-in runner. */
async function addCheckedItem(box, title, command) {
  const result = await box.runLocal(box.repo, ['add', 'coordinator', title, '--check', command, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

// Process-level: the consent prompt is read from live stdout/stderr streams of a child while its stdin stays open.
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

test('cli.journeys-baseline-check.v2-n23-only-the-coordinator-sets: [V2,N23] only the coordinator sets checks and agents confirm them before execution', async () => {
  const box = await project();
  const itemCountBefore = queryBoard(box, 'SELECT COUNT(*) AS count FROM item').count;
  const eventCountBefore = queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count;
  const forbiddenCreate = await box.runLocal(box.web, ['add', 'web', 'Agent supplied check', '--check', 'true', '--json']);
  assert.equal(forbiddenCreate.status, 1, forbiddenCreate.stderr);
  assert.equal(JSON.parse(forbiddenCreate.stdout).error.code, 'COORDINATOR_CHECK');
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM item').count, itemCountBefore, 'refusal adds no item');
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count, eventCountBefore, 'refusal adds no event');

  const ordinary = await box.runLocal(box.web, ['add', 'web', 'Agent ordinary item', '--json']);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const ordinaryId = JSON.parse(ordinary.stdout).item.item_id;
  const rowBefore = queryBoard(box, 'SELECT item_title, item_check, item_updated_at FROM item WHERE item_id = ?', ordinaryId);
  const eventsBeforeEdit = queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count;
  const forbiddenEdit = await box.runLocal(box.web, ['edit', String(ordinaryId), '--check', 'true', '--json']);
  assert.equal(forbiddenEdit.status, 1, forbiddenEdit.stderr);
  assert.equal(JSON.parse(forbiddenEdit.stdout).error.code, 'COORDINATOR_CHECK');
  assert.deepEqual(queryBoard(box, 'SELECT item_title, item_check, item_updated_at FROM item WHERE item_id = ?', ordinaryId), rowBefore);
  assert.equal(queryBoard(box, 'SELECT COUNT(*) AS count FROM event').count, eventsBeforeEdit, 'refused edit changes no event');

  for (const args of [
    ['add', 'web', 'Empty agent check', '--check', '', '--json'],
    ['edit', String(ordinaryId), '--check', '', '--json'],
  ]) {
    const refused = await box.runLocal(box.web, args);
    assert.equal(refused.status, 1, 'explicitly setting or clearing an empty check also belongs to the coordinator');
    assert.equal(JSON.parse(refused.stdout).error.code, 'COORDINATOR_CHECK');
  }

  const coordinatorCommand = markerCheck('check-ran-coordinator.txt');
  const coordinatorId = await addCheckedItem(box, 'Coordinator check', coordinatorCommand);
  const coordinatorResult = await box.runLocal(box.repo, ['check', String(coordinatorId)]);
  assert.equal(coordinatorResult.status, 0, coordinatorResult.stderr);
  assert.match(coordinatorResult.stdout, /set by coordinator/iu, 'even the setter sees the command attribution');
  assert.ok(coordinatorResult.stdout.includes(coordinatorCommand), 'the exact command is printed before execution');
  assert.doesNotMatch(coordinatorResult.stderr, /Run this check/iu, 'the setter needs no consent prompt');
  assert.equal(readFileSync(join(box.repo, 'check-ran-coordinator.txt'), 'utf8'), 'ran');

  const interactiveCommand = markerCheck('check-ran-interactive.txt');
  const interactiveId = ordinaryId;
  const authored = await box.runLocal(box.repo, ['edit', String(interactiveId), '--check', interactiveCommand, '--json']);
  assert.equal(authored.status, 0, authored.stdout + authored.stderr);
  assert.equal(queryBoard(box, 'SELECT item_created_by FROM item WHERE item_id = ?', interactiveId).item_created_by, 'web-1',
    'the check setter is derived from the edit, independently of the item creator');
  const eofRefusal = await box.runLocal(box.web, ['check', String(interactiveId), '--json'], '');
  assert.equal(eofRefusal.status, 1, eofRefusal.stderr);
  assert.equal(JSON.parse(eofRefusal.stdout).error.code, 'CHECK_CONFIRM');
  assert.ok(eofRefusal.stderr.includes(interactiveCommand), 'JSON mode prints the exact command before requesting consent');
  assert.match(eofRefusal.stderr, /set by coordinator[\s\S]*Run this check\?/u);
  const interactiveMarker = join(box.web, 'check-ran-interactive.txt');
  assert.equal(existsSync(interactiveMarker), false,
    'EOF refusal runs no check command');
  const declined = await box.runLocal(box.web, ['check', String(interactiveId), '--json'], 'no\n');
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
  const yesResult = await box.runLocal(box.web, ['check', String(yesId), '--yes', '--json']);
  assert.equal(yesResult.status, 0, yesResult.stderr);
  assert.equal(JSON.parse(yesResult.stdout).by, 'coordinator', 'JSON retains check attribution');
  assert.equal(JSON.parse(yesResult.stdout).check, yesCommand);
  assert.equal(readFileSync(join(box.web, 'check-ran-yes.txt'), 'utf8'), 'ran');
});

test('cli.journeys-baseline-check.a-check-that-pipes-its-proof: a check that pipes its proof into tail is refused [C7,V4]', () => {
  const board = openBoard(':memory:');
  try {
    const masked = { by: 'coordinator', lane: 'core', title: 'Masked proof', criterion: 'the proof passes', route: 'strong', check: `${shellWord(process.execPath)} -e "process.exit(1)" | tail -5` };
    assert.throws(() => validateItemAddition(board, masked), (error) => error.code === 'CHECK_MASKS_EXIT'
      && /pipes its proof into tail/u.test(error.message) && /pipefail/u.test(error.message));
  } finally { closeBoard(board); }
});

test('cli.journeys-baseline-check.a-captured-output-check-is-accepted: a captured-output check is accepted [C7,V4]', () => {
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

test('cli.journeys-baseline-check.an-uncaptured-grep-that-decides-the: an uncaptured grep that decides the exit is refused [C7,V4]', () => {
  assert.equal(maskRefusal('node -e "process.exit(1)" | grep -q x'), 'CHECK_MASKS_EXIT');
});

test('cli.journeys-baseline-check.a-pipe-into-xargs-that-hides: a pipe into xargs that hides the exit is refused [C7,V4]', () => {
  assert.equal(maskRefusal('node -e "process.exit(1)" | xargs echo'), 'CHECK_MASKS_EXIT');
});

test('cli.journeys-baseline-check.a-bare-pipefail-mention-in-an: a bare pipefail mention in an echo does not stop a masked pipe being refused [C7,V4]', () => {
  assert.equal(maskRefusal('echo pipefail; node -e "process.exit(1)" | tail -5'), 'CHECK_MASKS_EXIT');
});

test('cli.journeys-baseline-check.a-check-that-sets-pipefail-as: a check that sets pipefail as a command is accepted [C7,V4]', () => {
  assert.equal(maskRefusal('set -o pipefail; node -e "process.exit(1)" | tail -5'), null);
});

test('cli.journeys-baseline-check.a-pipe-into-tail-inside-a: a pipe into tail inside a subshell or after an assignment is refused [C7,V4]', () => {
  const masked = `node -e "console.log('proof-red'); process.exit(7)" | tail -n1`;
  // A capture exempts only a pipeline that tests the captured value; this one is never read (#812 review).
  assert.equal(maskRefusal(`out=$(printf ok); ${masked}`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`name=value; ${masked}`), 'CHECK_MASKS_EXIT', 'after a plain assignment');
  // A ( ) subshell or { ; } group exits with its last stage, so its pipes count; only $( ) hides them (#812 review).
  assert.equal(maskRefusal(`(${masked})`), 'CHECK_MASKS_EXIT');
  assert.equal(maskRefusal(`{ ${masked}; }`), 'CHECK_MASKS_EXIT');
});

test('cli.journeys-baseline-check.the-board-s-own-captured-output: the board\'s own captured-output form is accepted [C7,V4]', () => {
  assert.equal(maskRefusal(`out=$(node apps/cli/src/io/run/tests.js test/x.test.js 2>&1); printf "%s\\n" "$out"; printf "%s\\n" "$out" | grep -Eq "^# fail 0$" && printf "%s\\n" "$out" | grep -Eq "ok"`), null);
  assert.equal(maskRefusal(`out=$(node -e "process.exit(1)" | tail -5); echo "$out" | grep -q ok`), null, 'a pipe inside the capture is not a check pipeline');
});

test('cli.journeys-baseline-check.a-check-that-turns-pipefail-off: a check that turns pipefail off or sets it conditionally is refused [C7,V4]', () => {
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

test('cli.journeys-baseline-check.a-pipe-inside-a-shell-comment: a pipe inside a shell comment is not a pipeline [C7,V4]', () => {
  assert.equal(maskRefusal('printf proof-green # example only: false | tail'), null);
  assert.equal(maskRefusal('echo a#b | tail -n1'), 'CHECK_MASKS_EXIT', 'a # inside a word starts no comment');
});
