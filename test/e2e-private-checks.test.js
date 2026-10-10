/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseSpec } from '../src/spec.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import * as store from '../src/board.js';

import { createE2eHelpers } from './e2e-helpers.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('accept installs ignored dependencies from frozen policy and doctor audits the same private check [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'echo frozen-install-ran; mkdir -p web/.deps; printf installed > web/.deps/ready',
    check: 'test -f web/.deps/ready',
  });
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'the private install created the ignored dependency folder', '--json');
  assert.equal(accepted.code, 0, accepted.err);
  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.out);

  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); }
  finally { store.closeBoard(board); }
  writeFileSync(join(box.web, 'pullboard.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8')), check: { install: 'echo malicious-install-ran; exit 7', timeout: '1ms' } }));
  const changed = attackCommit(box, box.web);
  const proof = checkAtCommit(box.repo, { ...item, item_commit: changed });
  assert.equal(proof.state, 'pass');
  assert.match(proof.output, /frozen-install-ran/);
  assert.doesNotMatch(proof.output, /malicious-install-ran/);
});

test('accept without check.install keeps CHECK_RED and names the missing setting [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'echo check-failed; test -f web/.deps/ready' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'checking missing private dependency', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /check\.install/);
  assert.match(error.message, /output digest/);
  assert.match(error.message, /check-failed/);
  assert.match(error.next, /^reject with the failing behavior or ask the builder to fix and resubmit/);
});

test('check refusal shows secret-scanned failure lines and a durable full-output file [V18,V2]', () => {
  const planted = 'sk-proj-' + 'a'.repeat(40);
  const box = privateCheckSubmission({ check: `i=1; while [ "$i" -le 45 ]; do echo "CHECK-LINE-$i"; i=$((i + 1)); done; printf '%s\\n' 'ASSERTION: expected 4, received 3' 'OPENAI_KEY=${planted}'; exit 1` });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the frozen assertion fails', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /check failed \(exit 1\)/);
  assert.match(error.message, /ASSERTION: expected 4, received 3/);
  assert.match(error.message, /redacted OpenAI key/);
  assert.doesNotMatch(error.message, new RegExp(planted));
  assert.match(error.message, /last output lines \(up to 40\)/);
  const tail = /last output lines \(up to 40\):\n([\s\S]*?)\nfull output file:/.exec(error.message)?.[1] ?? '';
  assert.match(tail, /CHECK-LINE-9/);
  assert.doesNotMatch(tail, /CHECK-LINE-8/);
  assert.match(tail, /CHECK-LINE-45/);
  const artifact = /full output file: ([^\n]+)/.exec(error.message)?.[1];
  assert.ok(artifact && existsSync(artifact), `missing diagnostic artifact: ${artifact}`);
  const saved = readFileSync(artifact, 'utf8');
  assert.match(saved, /ASSERTION: expected 4, received 3/);
  assert.match(saved, /redacted OpenAI key/);
  assert.doesNotMatch(saved, new RegExp(planted));
  assert.equal((statSync(artifact).mode & 0o777), 0o600, 'private verifier artifacts are owner-readable only');
});

test('check refusal stays typed and includes bounded diagnostics when artifact storage is unavailable [V18,V19]', () => {
  const box = privateCheckSubmission({ check: 'echo diagnostic-tail-marker; exit 1' });
  const gitDir = box.git(box.repo, 'rev-parse', '--git-common-dir');
  const outputDirectory = join(box.repo, gitDir, 'pullboard');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, 'check-output'), 'blocks the diagnostic directory');
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the failing check cannot save a full artifact', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /diagnostic-tail-marker/);
  assert.match(error.message, /full output file: \(unavailable: EEXIST\)/);
  assert.match(error.next, /^reject with the failing behavior/);
});

test('private worker drains noisy output and reports a failed log path instead of timing out [V18,V19]', () => {
  const box = project();
  const worker = resolve(import.meta.dirname, '../src/private-check-worker.js');
  const output = spawnSync(process.execPath, [worker], {
    input: JSON.stringify({ command: `node -e 'process.stdout.write("START-WORKER\\n"); process.stdout.write(Buffer.alloc(20 * 1024 * 1024, 120)); process.stdout.write("\\nEND-WORKER\\n")'`,
      timeout: 10_000, pidFile: join(box.dir, 'worker.pid'), logPath: join(box.dir, 'missing', 'check.log') }),
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, 0);
  assert.deepEqual(result.error, null);
  assert.deepEqual(result.logError, { code: 'ENOENT' });
  assert.match(result.output, /START-WORKER/);
  assert.match(result.output, /END-WORKER/);
  assert.match(result.output, /output capped at 8 MiB; middle omitted/);
});

test('full multiline output artifact streams beyond the bounded capture under a constrained heap [V18,V2]', () => {
  const box = privateCheckSubmission({ check: `node -e 'const fs=require("node:fs"); const line=Buffer.alloc(1023,120); fs.writeSync(1,"START-FULL\\n"); for(let i=0;i<9000;i++){fs.writeSync(1,line);fs.writeSync(1,"\\n")} fs.writeSync(1,"TAIL-FULL-OUTPUT\\n"); process.exitCode=1'` });
  box.env.NODE_OPTIONS = '--max-old-space-size=96';
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the full failing check output is retained', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /TAIL-FULL-OUTPUT/);
  const artifact = /full output file: ([^\n]+)/.exec(error.message)?.[1];
  assert.ok(artifact && existsSync(artifact));
  const saved = readFileSync(artifact, 'utf8');
  assert.ok(Buffer.byteLength(saved) > 8 * 1024 * 1024);
  assert.match(saved, /START-FULL/);
  assert.match(saved, /TAIL-FULL-OUTPUT/);
  assert.equal((statSync(artifact).mode & 0o777), 0o600);
});

test('oversized single output lines are discarded with an explicit safe-scan marker [V18,V2]', () => {
  const planted = 'sk-proj-' + 'z'.repeat(40);
  const box = privateCheckSubmission({ check: `node -e 'process.stdout.write("BEGIN-LONG\\n"+"😀".repeat(17*1024)+"${planted}\\nTAIL-LONG\\n");process.exitCode=1'` });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the oversized diagnostic line must fail closed', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /redacted output line exceeds 64 KiB safe-scan limit/);
  assert.match(error.message, /TAIL-LONG/);
  const artifact = /full output file: ([^\n]+)/.exec(error.message)?.[1];
  assert.ok(artifact && existsSync(artifact));
  const saved = readFileSync(artifact, 'utf8');
  assert.match(saved, /redacted output line exceeds 64 KiB safe-scan limit/);
  assert.doesNotMatch(saved, new RegExp(planted));
});

test('stream scanning handles UTF-8 and a secret split across read chunks [V18,V2]', () => {
  const planted = 'sk-proj-' + 'b'.repeat(40);
  const box = privateCheckSubmission({ check: `node -e 'const fs=require("node:fs"); fs.writeSync(1,"x".repeat(32766)+"😀\\n"); fs.writeSync(1,"x".repeat(32762)+"${planted}\\nTAIL-CHUNK\\n"); process.exitCode=1'` });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the streamed scanner handles chunk boundaries', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /redacted OpenAI key/);
  const artifact = /full output file: ([^\n]+)/.exec(error.message)?.[1];
  assert.ok(artifact && existsSync(artifact));
  const saved = readFileSync(artifact, 'utf8');
  assert.match(saved, /😀/);
  assert.match(saved, /redacted OpenAI key/);
  assert.doesNotMatch(saved, new RegExp(planted));
  assert.match(saved, /TAIL-CHUNK/);
});

test('accept reports failed install as CHECK_UNVERIFIED with an output digest [V18,V2]', () => {
  const box = privateCheckSubmission({ install: 'echo install-failed; exit 9', check: 'true' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'install must complete before verification', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /install failed/);
  assert.match(error.message, /output digest/);
  assert.match(error.message, /install-failed/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('private check digest keeps install and noisy check output in separate sections [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'echo install-marker',
    check: 'i=0; while [ "$i" -lt 200 ]; do echo noisy-check-output-$i; i=$((i + 1)); done; echo check-failed; exit 1',
  });
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); }
  finally { store.closeBoard(board); }
  const proof = checkAtCommit(box.repo, item);
  assert.equal(proof.state, 'red');
  assert.match(proof.report, /install output:\ninstall-marker/);
  assert.match(proof.report, /check output:[\s\S]*check-failed/);
});

test('a submission without a frozen check keeps the no-check pass path [V18,V2]', () => {
  assert.deepEqual(checkAtCommit('/missing/private/repository', {}), {
    state: 'pass', green: true, checked: false, report: '',
  });
});

test('accept runs a successful frozen check that writes a file larger than the log cap [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'mkdir -p web/.deps; node -e \'require("node:fs").writeFileSync("web/.deps/check.bin", Buffer.alloc(20 * 1024 * 1024)); console.log("large-check-file-written")\'' });
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'the check wrote its real 20 MiB artifact', '--json');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
});

test('accept installs a real dependency file larger than the log cap before checking [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'mkdir -p web/.deps; node -e \'require("node:fs").writeFileSync("web/.deps/dependency.bin", Buffer.alloc(20 * 1024 * 1024)); console.log("large-install-file-written")\'',
    check: 'node -e \'if (require("node:fs").statSync("web/.deps/dependency.bin").size !== 20 * 1024 * 1024) process.exit(1)\'',
  });
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'the private install produced the complete 20 MiB dependency', '--json');
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(JSON.parse(accepted.out).decision, 'ACCEPT');
  const doctor = box.run(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.out);
});

test('a successful noisy check drains beyond the log cap and keeps bounded head and tail output [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'node -e \'process.stdout.write("BEGIN-MARKER\\n"); process.stdout.write(Buffer.alloc(20 * 1024 * 1024, 120)); process.stdout.write("\\nEND-MARKER\\n")\'' });
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); } finally { store.closeBoard(board); }
  const proof = checkAtCommit(box.repo, item);
  assert.equal(proof.state, 'pass', proof.report);
  assert.ok(proof.output.length < 8 * 1024 * 1024 + 256, 'only a bounded capture reaches the caller');
  assert.match(proof.output, /BEGIN-MARKER/);
  assert.match(proof.output, /END-MARKER/);
  assert.match(proof.output, /output capped at 8 MiB; middle omitted/);
  const accepted = box.run(box.review, 'verify', '1', 'accept', '--note', 'a noisy successful check passes with bounded output', '--json');
  assert.equal(accepted.code, 0, accepted.out);
});

test('accept reports a frozen check timeout as CHECK_UNVERIFIED [V18,V2]', () => {
  const box = privateCheckSubmission({ timeout: '100ms', check: 'echo timeout-marker; case "$PULLBOARD_HOME" in */pullboard-criterion-*/home/.pullboard) while :; do :; done;; *) exit 1;; esac' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the frozen check exceeded its configured timeout', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /check timed out/);
  assert.match(error.message, /timeout-marker/);
  assert.match(error.message, /full output file:/);
  assert.match(error.message, /output digest/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('a frozen check whose shell cannot start is identified as a startup failure [V18,V2]', () => {
  const box = privateCheckSubmission({ check: 'echo forbidden-shell-ran' });
  const isolatedPath = join(box.dir, 'git-only-path');
  mkdirSync(isolatedPath);
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(gitPath, join(isolatedPath, 'git'));
  box.env.PATH = isolatedPath;
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the shell is unavailable', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /check could not start \(ENOENT\)/);
  assert.doesNotMatch(error.message, /forbidden-shell-ran/);
  assert.match(error.message, /full output file:/);
});

test('accept reports a frozen install timeout before running the check [V18,V2]', () => {
  const box = privateCheckSubmission({ timeout: '100ms', install: 'echo install-started; while :; do :; done', check: 'echo forbidden-check-ran' });
  const refused = box.run(box.review, 'verify', '1', 'accept', '--note', 'the install must finish within its frozen deadline', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /install timed out/);
  assert.match(error.message, /install-started/);
  assert.doesNotMatch(error.message, /forbidden-check-ran/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('private check timeout kills a TERM-resistant shell and its tracked child [V18,V2]', () => {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  // The shell must start and write both pid files inside this budget; on a loaded machine that takes seconds.
  const budget = '2s';
  config.check = { install: '', timeout: budget };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure bounded check fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Bounded check', '--specs', 'G1', '--criterion', 'the check stops within its timeout', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  const pidFile = join(box.dir, 'private-check-child.pid');
  const check = `sleep 30 & echo $! > '${pidFile}'; trap 'while :; do :; done' TERM; while :; do :; done`;
  const item = { item_frozen: JSON.stringify({ check }), item_claim_head: commit, item_commit: commit };
  const modulePath = resolve(import.meta.dirname, '../src/trusted-policy.js');
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
    assert.equal(JSON.parse(outer.stdout).stage, 'check timed out');
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
