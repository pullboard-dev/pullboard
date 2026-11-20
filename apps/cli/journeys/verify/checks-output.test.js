/** @pullboard-test-input apps/runner/index.js packages/gate/src/io/browser/guard.js */
/**
 * End to end on real repos: streamed output scanning, the launch guard and digests (V18, V2).
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { checkAtCommit } from '../../../runner/index.js';

import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  sandbox, privateCheckSubmission,
} = e2e;

test('cli.journeys-verify-checks-output.oversized-single-output-lines-are-discarded: oversized single output lines are discarded with an explicit safe-scan marker [V18,V2]', async () => {
  const planted = 'sk-proj-' + 'z'.repeat(40);
  const box = privateCheckSubmission({ check: `node -e 'process.stdout.write("BEGIN-LONG\\n"+"😀".repeat(17*1024)+"${planted}\\nTAIL-LONG\\n");process.exitCode=1'` });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the oversized diagnostic line must fail closed', '--json');
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

test('cli.journeys-verify-checks-output.stream-scanning-handles-utf-8-and: stream scanning handles UTF-8 and a secret split across read chunks [V18,V2]', async () => {
  const planted = 'sk-proj-' + 'b'.repeat(40);
  const box = privateCheckSubmission({ check: `node -e 'const fs=require("node:fs"); fs.writeSync(1,"x".repeat(32766)+"😀\\n"); fs.writeSync(1,"x".repeat(32762)+"${planted}\\nTAIL-CHUNK\\n"); process.exitCode=1'` });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the streamed scanner handles chunk boundaries', '--json');
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

test('cli.journeys-verify-checks-output.a-check-output-survives-the-browser: a check output survives the browser launch guard [V18,V2]', async () => {
  const probe = sandbox();
  const observed = join(probe.dir, 'guard-stdio.json');
  const preload = join(probe.dir, 'observe-guard.mjs');
  const guard = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/src/io/browser/guard.js')).href;
  // Observe only the node -e check writer. Other CLI processes legitimately use their own stdio.
  writeFileSync(preload, `
const fs = process.getBuiltinModule('node:fs');
const accessed = [];
if (process.argv.length === 1) {
  for (const name of ['stdin', 'stdout', 'stderr']) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { ...descriptor, get() {
      accessed.push(name);
      return descriptor.get.call(process);
    } });
  }
}
await import(${JSON.stringify(guard)});
if (process.argv.length === 1) fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(accessed));
`);
  const planted = 'sk-proj-' + 'b'.repeat(40);
  const box = privateCheckSubmission({ check: `node -e 'const fs=require("node:fs"); fs.writeSync(1,"x".repeat(32766)+"😀\\n"); fs.writeSync(1,"x".repeat(32762)+"${planted}\\nTAIL-CHUNK\\n"); process.exitCode=1'` });
  box.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  box.env.PULLBOARD_TEST_BROWSER_SLOT = 'none';
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'the guard preserves the private check writer', '--json');
  assert.equal(refused.code, 1, refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_RED');
  assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), [], 'loading the guard must not initialize a check writer’s stdio');
  assert.match(error.message, /redacted OpenAI key/);
  assert.match(error.message, /TAIL-CHUNK/);
  const artifact = /full output file: ([^\n]+)/.exec(error.message)?.[1];
  assert.ok(artifact && existsSync(artifact));
  const saved = readFileSync(artifact, 'utf8');
  assert.match(saved, /😀/);
  assert.match(saved, /redacted OpenAI key/);
  assert.match(saved, /TAIL-CHUNK/);
  assert.doesNotMatch(saved, new RegExp(planted));
});

test('cli.journeys-verify-checks-output.a-submission-without-a-frozen-check: a submission without a frozen check keeps the no-check pass path [V18,V2]', () => {
  assert.deepEqual(checkAtCommit('/missing/private/repository', {}), {
    state: 'pass', green: true, checked: false, report: '',
  });
});
