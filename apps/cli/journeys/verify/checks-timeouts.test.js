/** @pullboard-test-input apps/runner/index.js */
/**
 * End to end on real repos: oversized artifacts, check timeouts and startup failures (V18, V2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { checkAtCommit } from '../../../runner/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, attackCommit, privateCheckSubmission,
} = e2e;

test('accept runs a successful frozen check that writes a file larger than the log cap [V18,V2]', async () => {
  const box = privateCheckSubmission({ check: 'mkdir -p web/.deps; node -e \'require("node:fs").writeFileSync("web/.deps/check.bin", Buffer.alloc(20 * 1024 * 1024)); console.log("large-check-file-written")\'' });
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the check wrote its real 20 MiB artifact', '--json');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
});

test('accept installs a real dependency file larger than the log cap before checking [V18,V2]', async () => {
  const box = privateCheckSubmission({
    install: 'mkdir -p web/.deps; node -e \'require("node:fs").writeFileSync("web/.deps/dependency.bin", Buffer.alloc(20 * 1024 * 1024)); console.log("large-install-file-written")\'',
    check: 'node -e \'if (require("node:fs").statSync("web/.deps/dependency.bin").size !== 20 * 1024 * 1024) process.exit(1)\'',
  });
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the private install produced the complete 20 MiB dependency', '--json');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
  const doctor = await box.runLocal(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.out);
});

test('a successful noisy check drains beyond the log cap and keeps bounded head and tail output [V18,V2]', async () => {
  const box = privateCheckSubmission({ check: 'node -e \'process.stdout.write("BEGIN-MARKER\\n"); process.stdout.write(Buffer.alloc(20 * 1024 * 1024, 120)); process.stdout.write("\\nEND-MARKER\\n")\'' });
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); } finally { store.closeBoard(board); }
  const proof = checkAtCommit(box.repo, item);
  assert.equal(proof.state, 'pass', proof.report);
  assert.ok(proof.output.length < 8 * 1024 * 1024 + 256, 'only a bounded capture reaches the caller');
  assert.match(proof.output, /BEGIN-MARKER/);
  assert.match(proof.output, /END-MARKER/);
  assert.match(proof.output, /output capped at 8 MiB; middle omitted/);
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'a noisy successful check passes with bounded output', '--json');
  assert.equal(accepted.code, 0, accepted.out);
});

test('accept reports a frozen check timeout as CHECK_UNVERIFIED [V18,V2]', async () => {
  const box = privateCheckSubmission({ timeout: '100ms', check: 'echo timeout-marker; case "$PULLBOARD_HOME" in */pullboard-criterion-*/home/.pullboard) while :; do :; done;; *) exit 1;; esac' });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the frozen check exceeded its configured timeout', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /check timed out/);
  assert.match(error.message, /timeout-marker/);
  assert.match(error.message, /full output file:/);
  assert.match(error.message, /output digest/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('a frozen check whose shell cannot start is identified as a startup failure [V18,V2]', async () => {
  const box = privateCheckSubmission({ check: 'echo forbidden-shell-ran' });
  const isolatedPath = join(box.dir, 'git-only-path');
  mkdirSync(isolatedPath);
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(gitPath, join(isolatedPath, 'git'));
  box.env.PATH = isolatedPath;
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the shell is unavailable', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /check could not start \(ENOENT\)/);
  assert.doesNotMatch(error.message, /forbidden-shell-ran/);
  assert.match(error.message, /full output file:/);
});

test('accept reports a frozen install timeout before running the check [V18,V2]', async () => {
  const box = privateCheckSubmission({ timeout: '100ms', install: 'echo install-started; while :; do :; done', check: 'echo forbidden-check-ran' });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the install must finish within its frozen deadline', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /install timed out/);
  assert.match(error.message, /install-started/);
  assert.doesNotMatch(error.message, /forbidden-check-ran/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('clause 1: private check timeout kills a TERM-resistant shell and its tracked child [V18,V2]', async () => {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  // The shell must start and write both pid files inside this budget; on a loaded machine that takes seconds.
  const budget = '2s';
  config.check = { install: '', timeout: budget };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure bounded check fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Bounded check', '--specs', 'G1', '--criterion', 'the check stops within its timeout', '--check', 'true', '--brief', 'Files:\n- web/index.html\nTest:\n- the check stops').code, 0);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  const pidFile = join(box.dir, 'private-check-child.pid');
  const check = `sleep 30 & echo $! > '${pidFile}'; trap 'while :; do :; done' TERM; while :; do :; done`;
  const item = { item_frozen: JSON.stringify({ check }), item_claim_head: commit, item_commit: commit };
  const modulePath = resolve(import.meta.dirname, '../../../runner/index.js');
  const source = `import { checkAtCommit } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(checkAtCommit(process.argv[1], JSON.parse(process.argv[2]))));`;
  const shellPidFile = join(box.dir, 'private-check-shell.pid');
  const trackedCheck = `echo $$ > '${shellPidFile}'; ${check}`;
  const trackedItem = { ...item, item_frozen: JSON.stringify({ check: trackedCheck }) };
  let outer;
  try {
    outer = spawnSync(process.execPath, ['--input-type=module', '-e', source, box.repo, JSON.stringify(trackedItem)], {
      cwd: box.repo, env: box.env, encoding: 'utf8', detached: true,
    });
    assert.equal(outer.error, undefined, outer.error?.message);
    assert.equal(outer.status, 0, outer.stderr);
    assert.match(JSON.parse(outer.stdout).stage, /^check timed out after \d+\.\d seconds against its \d+\.\d second ceiling/);
    if (!existsSync(pidFile)) {
      assert.fail(existsSync(shellPidFile)
        ? `the check was killed before it forked its tracked child: its shell started, but ${pidFile} never appeared within the ${budget} check budget`
        : `the check was killed before its shell started, so it never forked: ${shellPidFile} never appeared within the ${budget} check budget`);
    }
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    let childAlive = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { process.kill(childPid, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
      catch { childAlive = false; break; }
    }
    assert.equal(childAlive, false, 'the tracked grandchild exits after its timeout');
  } finally {
    const fixturePids = [pidFile, shellPidFile].flatMap(path => {
      try { return [Number(readFileSync(path, 'utf8').trim())]; }
      catch { return []; }
    }).filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    if (outer?.error?.code === 'ETIMEDOUT' && outer.pid) fixturePids.push(outer.pid);
    for (const pid of new Set(fixturePids)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* This fixture process has already exited. */ }
    }
  }
});
