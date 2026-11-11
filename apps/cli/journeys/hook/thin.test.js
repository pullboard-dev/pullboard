/**
 * The commit hooks outside an agent session run a thin entry: at most 1,000 modules load for pre-commit and for
 * commit-msg, and exit code and stderr match the full path for an accepted and a blocked message [H24].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { runThinHook } from '../../src/io/hook/thin.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const MODULE_BUDGET = 1000;
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Run one hook through node with a module-load counter and return the result and the distinct modules loaded. */
function counted(box, cwd, extraEnv, args) {
  const loader = join(box.dir, 'count-loader.mjs');
  const preload = join(box.dir, 'count-hooks.mjs');
  const counts = join(box.dir, 'count.txt');
  writeFileSync(loader, "import { appendFileSync } from 'node:fs';\nexport async function load(url, ctx, next) { appendFileSync(process.env.COUNT_FILE, url + '\\n'); return next(url, ctx); }\n");
  writeFileSync(preload, "import { register } from 'node:module';\nregister('./count-loader.mjs', import.meta.url);\n");
  rmSync(counts, { force: true });
  const bin = join(box.dir, 'bin/pullboard');
  const shim = readFileSync(bin, 'utf8').match(/exec "([^"]+)" "([^"]+)"/u);
  const env = { ...box.env, ...extraEnv, COUNT_FILE: counts, NODE_OPTIONS: `--import ${preload}` };
  const result = runFixtureChild(shim[1], [shim[2], 'hook', ...args], { cwd, env, encoding: 'utf8' });
  const modules = existsSync(counts) ? new Set(readFileSync(counts, 'utf8').split('\n').filter(Boolean)) : new Set();
  return { code: result.status, err: result.stderr, modules: modules.size };
}

/** The same hook through the full dispatcher, which a marked agent session takes. */
function full(box, cwd, args) {
  return counted(box, cwd, { CLAUDECODE: '1' }, args);
}

test('pre-commit outside an agent session loads at most 1,000 modules and exits as the full path does [H24]', () => {
  const box = e2e.project('true');
  const thin = counted(box, box.web, {}, ['pre-commit']);
  const reference = full(box, box.web, ['pre-commit']);
  assert.ok(thin.modules <= MODULE_BUDGET, `thin pre-commit loaded ${thin.modules} modules, over ${MODULE_BUDGET}`);
  assert.ok(reference.modules > thin.modules, 'the full path still loads more than the thin one');
  assert.equal(thin.code, reference.code);
  assert.equal(thin.err, reference.err);
});

test('commit-msg outside an agent session loads at most 1,000 modules and matches the full path for an accepted and a blocked message [H24]', () => {
  const box = e2e.project('true');
  for (const [label, text] of [['accepted', 'feat(web): thing [G1]\n'], ['blocked', 'not a conventional message\n']]) {
    const file = join(box.dir, `${label}.msg`);
    writeFileSync(file, text);
    const thin = counted(box, box.web, {}, ['commit-msg', file]);
    const reference = full(box, box.web, ['commit-msg', file]);
    assert.ok(thin.modules <= MODULE_BUDGET, `thin ${label} commit-msg loaded ${thin.modules} modules, over ${MODULE_BUDGET}`);
    assert.equal(thin.code, reference.code, `${label}: exit code`);
    assert.equal(thin.err, reference.err, `${label}: stderr`);
    if (label === 'blocked') assert.notEqual(thin.code, 0, 'the blocked message is refused');
    else assert.equal(thin.code, 0, thin.err);
  }
});

test('a thin hook that refuses prints its refusal and exits 1 instead of crashing [H24]', async () => {
  const box = e2e.project('true');
  const chunks = [];
  const sink = { write(text) { chunks.push(String(text)); return true; } };
  const code = await runThinHook(['hook', 'no-such-hook'], { cwd: box.web, stdout: sink, stderr: sink, stdin: process.stdin });
  const text = chunks.join('');
  assert.equal(code, 1);
  assert.match(text, /\[USAGE\] pullboard hook pre-commit/u);
  assert.match(text, /\nnext: /u);
});
