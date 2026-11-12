/**
 * The commit hooks run a thin entry, in an agent session too with only the checkout lease bind added: at most 1,000
 * modules load for pre-commit and for commit-msg, exit code and stderr match the full path for an accepted and a
 * blocked message, and a named staged static check runs in the hook's own process [H24].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  writeFileSync(loader, "import { appendFileSync } from 'node:fs';\nexport async function load(url, ctx, next) { appendFileSync(process.env.COUNT_FILE, process.pid + ' ' + url + '\\n'); return next(url, ctx); }\n");
  writeFileSync(preload, "import { register } from 'node:module';\nregister('./count-loader.mjs', import.meta.url);\n");
  rmSync(counts, { force: true });
  const bin = join(box.dir, 'bin/pullboard');
  const shim = readFileSync(bin, 'utf8').match(/exec "([^"]+)" "([^"]+)"/u);
  const env = { ...box.env, ...extraEnv, COUNT_FILE: counts, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` };
  const result = runFixtureChild(shim[1], [shim[2], 'hook', ...args], { cwd, env, encoding: 'utf8' });
  const loads = existsSync(counts) ? readFileSync(counts, 'utf8').split('\n').filter(Boolean).map(line => line.split(' ')) : [];
  const pidOf = suffix => loads.find(([, url]) => url.endsWith(suffix))?.[0] ?? null;
  return { code: result.status, err: result.stderr, modules: new Set(loads.map(([, url]) => url)).size, pidOf };
}

/** The same hook through the full dispatcher. */
function full(box, cwd, args, extraEnv = {}) {
  return counted(box, cwd, { ...extraEnv, PULLBOARD_HOOK_FULL: '1' }, args);
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

test('clause 2: an agent session takes the thin pre-commit with only the checkout lease bind added [H24]', () => {
  const box = e2e.project('true');
  const session = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'thin-hook-5719' };
  const binding = join(box.git(box.web, 'rev-parse', '--absolute-git-dir'), 'pullboard-checkout-session.json');
  assert.equal(existsSync(binding), false, 'the fixture seat starts with no session binding');
  const thin = counted(box, box.web, session, ['pre-commit']);
  assert.equal(thin.code, 0, thin.err);
  assert.ok(thin.modules <= MODULE_BUDGET, `agent pre-commit loaded ${thin.modules} modules, over ${MODULE_BUDGET}`);
  assert.equal(thin.pidOf('/apps/cli/src/io/cli-main/run.js'), null, 'the full dispatcher never loads');
  assert.equal(JSON.parse(readFileSync(binding, 'utf8')).agent, 'web-1', 'the first hook of a session binds the checkout to it');
  const again = counted(box, box.web, session, ['pre-commit']);
  assert.equal(again.code, 0, again.err);
  const other = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'another-session' };
  const refused = counted(box, box.web, other, ['pre-commit']);
  const reference = full(box, box.web, ['pre-commit'], other);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /NOT_YOUR_CHECKOUT/u, 'another session is refused, as the full path refuses it');
  assert.equal(reference.code, refused.code);
  assert.match(reference.err, /NOT_YOUR_CHECKOUT/u);
});

test('clause 2: a named staged static check runs inside the pre-commit process and blocks the commit [H24]', () => {
  const box = e2e.project('true');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.html'), '<p>hi</p>\n');
  box.git(box.web, 'add', 'web/page.html');
  const run = counted(box, box.web, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'static-5719',
    PULLBOARD_HOOK_STATIC: 'apps/cli/tests/fixtures/hook/static.js' }, ['pre-commit']);
  assert.equal(run.code, 1, run.err);
  const ran = /web\/page\.html:1: fixture static check ran in process (\d+)/u.exec(run.err);
  assert.ok(ran, `the static failure blocks the commit:\n${run.err}`);
  assert.equal(ran[1], run.pidOf('/apps/cli/src/io/hook/thin.js'), 'the check ran in the hook process itself');
});
