/** @pullboard-test-input apps/runner/index.js apps/runner/src/io/private/check/worker.js */
/**
 * End to end on real repos: the private check installs, refuses and keeps its full output (V18, V2, V19).
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
  attackCommit, privateCheckSubmission,
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
