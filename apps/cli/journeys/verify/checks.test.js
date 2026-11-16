/** @pullboard-test-input apps/runner/index.js apps/runner/src/io/private/check/worker.js */
/**
 * End to end on real repos: the private check installs, refuses and keeps its full output (V18, V2, V19).
 */
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
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
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, attackCommit, privateCheckSubmission,
} = e2e;

test('clause 2: accept installs ignored dependencies from frozen policy and doctor audits the same private check [V18,V2]', async () => {
  const box = privateCheckSubmission({
    install: 'echo frozen-install-ran; mkdir -p web/.deps; printf installed > web/.deps/ready',
    check: 'test -f web/.deps/ready',
  });
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the private install created the ignored dependency folder', '--json');
  assert.equal(accepted.code, 0, accepted.err);
  const doctor = await box.runLocal(box.repo, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.out);

  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
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

test('accept without check.install keeps CHECK_RED and names the missing setting [V18,V2]', async () => {
  const box = privateCheckSubmission({ check: 'echo check-failed; test -f web/.deps/ready' });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'checking missing private dependency', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /check\.install/);
  assert.match(error.message, /output digest/);
  assert.match(error.message, /check-failed/);
  assert.match(error.next, /^reject with the failing behavior or ask the builder to fix and resubmit/);
});

test('check refusal shows secret-scanned failure lines and a durable full-output file [V18,V2]', async () => {
  const planted = 'sk-proj-' + 'a'.repeat(40);
  const box = privateCheckSubmission({ check: `i=1; while [ "$i" -le 45 ]; do echo "CHECK-LINE-$i"; i=$((i + 1)); done; printf '%s\\n' 'ASSERTION: expected 4, received 3' 'OPENAI_KEY=${planted}'; exit 1` });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the frozen assertion fails', '--json');
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

test('check refusal stays typed and includes bounded diagnostics when artifact storage is unavailable [V18,V19]', async () => {
  const box = privateCheckSubmission({ check: 'echo diagnostic-tail-marker; exit 1' });
  const gitDir = box.git(box.repo, 'rev-parse', '--git-common-dir');
  const outputDirectory = join(box.repo, gitDir, 'pullboard');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, 'check-output'), 'blocks the diagnostic directory');
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the failing check cannot save a full artifact', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.match(error.message, /diagnostic-tail-marker/);
  assert.match(error.message, /full output file: \(unavailable: EEXIST\)/);
  assert.match(error.next, /^reject with the failing behavior/);
});

test('private worker drains noisy output and reports a failed log path instead of timing out [V18,V19]', () => {
  const box = project();
  const worker = resolve(import.meta.dirname, '../../../runner/src/io/private/check/worker.js');
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

test('full multiline output artifact streams beyond the bounded capture under a constrained heap [V18,V2]', async () => {
  const box = privateCheckSubmission({ check: `node -e 'const fs=require("node:fs"); const line=Buffer.alloc(1023,120); fs.writeSync(1,"START-FULL\\n"); for(let i=0;i<9000;i++){fs.writeSync(1,line);fs.writeSync(1,"\\n")} fs.writeSync(1,"TAIL-FULL-OUTPUT\\n"); process.exitCode=1'` });
  box.env.NODE_OPTIONS = '--max-old-space-size=96';
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the full failing check output is retained', '--json');
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
