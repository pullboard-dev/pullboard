/** A slow file on a loaded runner is judged by its cases, and a timeout names them [C7,V10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from '../../../fixtures/child.js';

const runner = fileURLToPath(new URL('../../../../../../apps/cli/src/io/run/tests.js', import.meta.url));

/** Run one fixture file under configured wall and idle limits, returning status and combined output. */
function run(t, name, source, { wallMs = 2000, idleMs = 4000, caseMs = 20000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-file-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, name), source);
  const result = runFixtureChild(process.execPath, [runner, join(root, name)], {
    cwd: root, encoding: 'utf8', detached: true,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: String(caseMs),
      PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ [name]: wallMs }), PULLBOARD_TEST_IDLE_TIMEOUT_MS: String(idleMs) },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const pause = "const pause = ms => new Promise(done => setTimeout(done, ms));\n";

test('gate.io-board-baseline-report.a-file-whose-cases-each-finish: a file whose cases each finish in budget can exceed three whole-file walls [C7,V10]', t => {
  const cases = Array.from({ length: 12 }, (_, index) => `test('case ${index + 1} [C7]', async () => { await pause(600); });`).join('\n');
  const { status, output } = run(t, 'sum.test.js', `import { test } from 'node:test';\n${pause}${cases}\n`);
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /TIMEOUT file|HUNG file/u);
});

test('gate.io-board-baseline-report.a-legitimate-first-case-keeps-its: a legitimate first case keeps its enforced budget beyond the whole-file wall [C7,V10]', t => {
  const { status, output } = run(t, 'first.test.js', `import { test } from 'node:test';
test('gate.io-board-baseline-report.long-first-case-c7: long first case [C7]', () => { const until = Date.now() + 4500; while (Date.now() < until) {} });
`, { wallMs: 1000, idleMs: 8000 });
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /TIMEOUT file|HUNG file|per-test timeout/u);
});

test('gate.io-board-baseline-report.a-file-that-stalls-reports-its: a file that stalls reports its running case and every finished case duration [C7,V10]', t => {
  const finished = Array.from({ length: 45 }, (_, index) => `test('finished ${index + 1} [C7]', async () => { await pause(10); });`);
  const { status, output } = run(t, 'stall.test.js', [
    "import { test } from 'node:test';", pause, ...finished,
    "test('the stuck case [C7]', () => { while (true) {} });",
  ].join('\n') + '\n', { wallMs: 3000, idleMs: 1000, caseMs: 1200 });
  assert.equal(status, 1, output);
  assert.match(output, /test "the stuck case \[C7\]" in .*stall\.test\.js failed: it ran [\d.]+s, past the 1200ms per-test timeout/u);
  const match = output.match(/finished cases (\[[^\r\n]*\])/u);
  assert.ok(match, output);
  const summaries = JSON.parse(match[1]);
  assert.equal(summaries.length, 45);
  assert.equal(summaries[0].name, 'finished 1 [C7]');
  assert.equal(summaries.at(-1).name, 'finished 45 [C7]');
  assert.ok(summaries.every(summary => Number.isInteger(summary.ms) && summary.ms >= 0));
});
