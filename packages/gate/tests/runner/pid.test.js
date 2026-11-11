/** @pullboard-test-input source-tree */
/** The test runner names itself to the tests it starts, so a test finds its runner without parsing ps text [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { awaitNestedRun } from '../../index.js';

const runner = fileURLToPath(new URL('../../src/io/run/tests.js', import.meta.url));

test('the test runner names itself to the tests it starts [C7]', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-pid-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = join(dir, 'seen.jsonl');
  const inner = join(dir, 'inner.test.js');
  const outer = join(dir, 'outer.test.js');
  writeFileSync(inner, `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
test('inner', () => { appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ who: 'inner', runner: process.env.PULLBOARD_TEST_RUNNER_PID }) + '\\n'); });
`);
  writeFileSync(outer, `import { appendFileSync } from 'node:fs';
import { awaitNestedRun } from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};
import { spawn } from 'node:child_process';
import { test } from 'node:test';
test('outer', async () => {
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ who: 'outer', runner: process.env.PULLBOARD_TEST_RUNNER_PID }) + '\\n');
  const nested = spawn(process.execPath, [${JSON.stringify(runner)}, ${JSON.stringify(inner)}], { stdio: 'ignore' });
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ who: 'nested runner', pid: String(nested.pid) }) + '\\n');
  const { status: code } = await awaitNestedRun(nested);
  if (code !== 0) throw new Error('the nested run failed with ' + code);
});
`);
  const child = spawn(process.execPath, [runner, outer], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { output += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { output += part; });
  const { status: code } = await awaitNestedRun(child);
  assert.equal(code, 0, output);
  const records = readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const by = (who) => records.find((record) => record.who === who);
  assert.equal(by('outer').runner, String(child.pid), 'a test file reads its runner pid');
  assert.equal(by('inner').runner, by('nested runner').pid, 'a nested run sees the nested runner pid, not the outer one');
  assert.notEqual(by('inner').runner, by('outer').runner);
});
