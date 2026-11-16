/** @pullboard-test-input apps/runner/index.js */
/**
 * End to end on real repos: oversized artifacts, check timeouts and startup failures (V18, V2).
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { checkAtCommit } from '../../../runner/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  privateCheckSubmission,
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
