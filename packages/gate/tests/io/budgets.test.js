/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/** Keep test timing judgments accountable to their actual work [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { wallClockViolations } from '../fixtures/budgets.js';

/** Initialize a private repository so scanner fixtures exercise git's tracked-file list. */
function initFixtureRepo(root) {
  execFileSync('git', ['init', '-q', root]);
}

/** Stage named scanner inputs while leaving later files available as untracked controls. */
function trackFixtureFiles(root, ...files) {
  execFileSync('git', ['add', '--', ...files], { cwd: root });
}

test('gate.io-budgets.the-clock-margin-guard-follows-separately: the clock-margin guard follows separately captured clock readings [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-clock-readings-'));
  try {
    initFixtureRepo(root);
    const file = join(root, 'readings.test.js');
    const source = 'const startedAt = Date.now();\nconst finishedAt = Date.now();\nassert.ok(finishedAt - startedAt < 30_000);\n';
    writeFileSync(file, source);
    trackFixtureFiles(root, 'readings.test.js');
    assert.match(wallClockViolations(root).join('\n'), /readings\.test\.js:3: literal elapsed-time margin/u);
    writeFileSync(file, source.replace('< 30_000);', '< 30_000); // budget: declared observation window is 30000ms.'));
    assert.deepEqual(wallClockViolations(root), [], 'the asserted margin accepts its same-line reason');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate.io-budgets.the-clock-margin-guard-follows-a: the clock-margin guard follows a fixed wait result into a later assertion [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wait-result-'));
  try {
    initFixtureRepo(root);
    const file = join(root, 'wait-result.test.js');
    const source = '/** Return false when the child-close deadline wins. */\nfunction childClosesWithin(child, timeoutMs) { return new Promise(resolve => { child.once("close", () => resolve(true)); setTimeout(() => resolve(false), timeoutMs); }); }\nconst closed = await childClosesWithin(child, 1500);\nassert.equal(closed, true);\n';
    writeFileSync(file, source);
    trackFixtureFiles(root, 'wait-result.test.js');
    assert.match(wallClockViolations(root).join('\n'), /wait-result\.test\.js:4: literal wait result judged by an assertion/u);
    writeFileSync(file, source.replace('assert.equal(closed, true);', 'assert.equal(closed, true); // budget: hang ceiling for the child-close handshake.'));
    assert.deepEqual(wallClockViolations(root), [], 'the later judgment accepts its same-line reason');
    writeFileSync(file, source.replace('assert.equal(closed, true);', ''));
    assert.deepEqual(wallClockViolations(root), [], 'an unasserted cleanup result is not a timing judgment');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate.io-budgets.the-clock-margin-guard-follows-waited: the clock-margin guard follows waited results through boolean assertions [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wait-boolean-'));
  try {
    initFixtureRepo(root);
    const file = join(root, 'wait-boolean.test.js');
    const prefix = '/** Return false when the child-close deadline wins. */\nfunction childClosesWithin(child, timeoutMs) { return new Promise(resolve => { child.once("close", () => resolve(true)); setTimeout(() => resolve(false), timeoutMs); }); }\nconst closed = await childClosesWithin(child, 1500);\n';
    for (const judgment of ['assert.ok(closed === true)', 'assert.ok(closed !== false)', 'assert(closed && true)',
      'assert.ok(Boolean(closed))', 'assert.ok(true ? closed : false)', 'assert.strictEqual(true, closed)', 'assert.deepEqual({closed}, {closed: true})']) {
      writeFileSync(file, prefix + judgment + ';\n');
      trackFixtureFiles(root, 'wait-boolean.test.js');
      assert.match(wallClockViolations(root).join('\n'), /wait-boolean\.test\.js:4: literal wait result judged by an assertion/u, judgment);
      writeFileSync(file, prefix + judgment + '; // budget: hang ceiling for the child-close handshake.\n');
      assert.deepEqual(wallClockViolations(root), [], 'the boolean judgment accepts its same-line reason');
    }
    for (const judgment of ['assert.ok(response.closed === true)', 'assert.equal(true, true, closed)',
      'assert.ok(true, closed === false)', 'assert.deepEqual({closed: true}, {closed: true})',
      'assert.ok("closed === true")', 'console.log(closed)']) {
      writeFileSync(file, prefix + judgment + ';\n');
      assert.deepEqual(wallClockViolations(root), [], judgment + ' does not judge the waited result');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate.io-budgets.the-clock-margin-guard-checks-both: the clock-margin guard checks both compared assertion arguments [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-compared-clock-'));
  try {
    initFixtureRepo(root);
    const file = join(root, 'compared-clock.test.js');
    const prefix = 'const startedAt = Date.now();\n';
    for (const judgment of ['assert.strictEqual(true, Date.now() - startedAt < 10)',
      'assert.equal(true, Date.now() - startedAt < 10)', 'assert.strictEqual(Date.now() - startedAt < 10, true)',
      'assert.strictEqual(10, Date.now() - startedAt)', 'assert.equal(Date.now() - startedAt, 10)']) {
      writeFileSync(file, prefix + judgment + ';\n');
      trackFixtureFiles(root, 'compared-clock.test.js');
      assert.match(wallClockViolations(root).join('\n'), /compared-clock\.test\.js:2: literal elapsed-time margin/u, judgment);
      writeFileSync(file, prefix + judgment + '; // budget: declared fixture delay is 10ms.\n');
      assert.deepEqual(wallClockViolations(root), [], 'either compared argument accepts its same-line reason');
    }
    for (const judgment of ['assert.strictEqual(true, true, Date.now() - startedAt < 10)',
      'assert.ok(true, Date.now() - startedAt < 10)', 'assert.strictEqual(true, "Date.now() - startedAt < 10")']) {
      writeFileSync(file, prefix + judgment + ';\n');
      assert.deepEqual(wallClockViolations(root), [], 'diagnostic arguments and quoted fixtures are excluded');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate.io-budgets.the-wall-clock-scanner-skips-ignored: the wall-clock scanner skips ignored worktrees [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wall-clock-tracked-'));
  try {
    initFixtureRepo(root);
    writeFileSync(join(root, '.gitignore'), '.claude/worktrees/\n');
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/tracked.test.js'), 'const startedAt = Date.now();\nassert.ok(Date.now() - startedAt < 30_000);\n');
    trackFixtureFiles(root, '.gitignore', 'test/tracked.test.js');
    const ignored = join(root, '.claude', 'worktrees', 'copy', 'test');
    mkdirSync(ignored, { recursive: true });
    writeFileSync(join(ignored, 'ignored.test.js'), 'const startedAt = Date.now();\nassert.ok(Date.now() - startedAt < 30_000);\n');
    writeFileSync(join(root, 'test/untracked.test.js'), 'const startedAt = Date.now();\nassert.ok(Date.now() - startedAt < 30_000);\n');

    assert.deepEqual(wallClockViolations(root), [
      'test/tracked.test.js:2: literal elapsed-time margin: assert.ok(Date.now() - startedAt < 30_000);',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate.io-budgets.no-test-judges-work-by-a: no test judges work by a fixed wall-clock margin [C7]', () => {
  assert.deepEqual(wallClockViolations(fileURLToPath(new URL('../../../..', import.meta.url))), []);
});

test('gate.io-budgets.the-clock-margin-guard-catches-planted: the clock-margin guard catches planted source and names its file and line [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wall-clock-'));
  try {
    initFixtureRepo(root);
    mkdirSync(join(root, 'nested'));
    const file = join(root, 'nested', 'planted.test.mjs');
    const bare = 'const start = Date.now();\nassert.ok(Date.now() - start < 30_000);\n';
    writeFileSync(file, bare);
    trackFixtureFiles(root, 'nested/planted.test.mjs');
    assert.match(wallClockViolations(root).join('\n'), /nested\/planted\.test\.mjs:2: literal elapsed-time margin/u);
    assert.throws(() => assert.deepEqual(wallClockViolations(root), []), error =>
      error.code === 'ERR_ASSERTION' && /nested\/planted\.test\.mjs:2/u.test(error.message), 'a planted bare clock margin makes the real guard red');
    writeFileSync(file, bare.replace('< 30_000);', '< 30_000); // budget: hang ceiling only; no throughput claim.'));
    assert.deepEqual(wallClockViolations(root), []);
    writeFileSync(file, 'assert.ok(Date.now() - start > 10_000); // budget: the stand-in publishes DevToolsActivePort after 10,100 ms.\n');
    assert.deepEqual(wallClockViolations(root), [], 'a concrete fixture publication delay explains the budget without special vocabulary');
    writeFileSync(file, 'const spent = performance.now() - start;\nassert.ok(spent < 1500);\nawait assert.rejects(waitFor(child, 1500));\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [2, 3]);
    writeFileSync(file, 'await assert.doesNotReject(waitFor(child, 1500));\nawait chrome.waitFor(ready, 1500);\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [1, 2]);
    writeFileSync(file, 'const budgetMs = 1500;\nassert.ok(elapsed < budgetMs);\nawait assert.rejects(waitFor(child, budgetMs));\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [2, 3]);
    writeFileSync(file, 'const text = "assert.ok(Date.now() - start < 1)";\nassert.equal(response.status, 200);\nassert.ok(elapsed < measuredBaseline * 3);\n');
    assert.deepEqual(wallClockViolations(root), []);
    writeFileSync(file, 'if (!await childClosesWithin(child, 1500)) return null;\nsetTimeout(() => reject(new Error("late")), 1500);\nassert.ok(elapsed < 1500); // budget: because I said so\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [1, 2, 3]);
    writeFileSync(file, 'await assert.rejects(browser(), error => {\n  assert.ok(elapsed >= 30000); // budget: declared startup timeout.\n});\nassert.equal((await event(worker)).waiting, 1);\nassert.equal(durationMs("2h"), 7200000);\nconst matcher = /[\'"`]/u;\nassert.ok(Date.now() - start < 1500);\n');
    assert.deepEqual(wallClockViolations(root).map(line => Number(/:(\d+):/u.exec(line)[1])), [7]);
    writeFileSync(file, '');
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/helper.js'), bare);
    writeFileSync(join(root, 'test.js'), bare);
    trackFixtureFiles(root, 'test/helper.js', 'test.js');
    assert.deepEqual(wallClockViolations(root).map(line => line.split(':')[0]).sort(), ['test.js', 'test/helper.js'],
      'plain test.js and every JavaScript file under test/ are part of native discovery');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
