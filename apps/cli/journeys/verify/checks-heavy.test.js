/** @pullboard-test-input apps/runner/index.js apps/runner/src/io/private/check/worker.js */
/**
 * The heavy-output private check cases, split from checks.test.js so they run in parallel (V18, V2, V19).
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

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  project, privateCheckSubmission,
} = e2e;

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
