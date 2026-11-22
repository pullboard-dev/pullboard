/** Real Git pairs measure only the two maintenance opt-in setup commits [C7,#12968]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { parityText } from '../../../fixtures/e2e.js';
import { enable as enableMaintenance } from '../../../fixtures/worktree/maintenance.js';
import { enable as enableLifecycle } from '../../../fixtures/worktree/maintenance/lifecycle.js';

const BIN = resolve(import.meta.dirname, '../../../../pullboard.js');

/** Count actual external starts, then execute the shipped hook; no hook result is substituted. */
function spyHooks(box) {
  const hooks = join(box.dir, 'counted-hooks'), marks = join(box.dir, 'hook-starts');
  mkdirSync(hooks);
  for (const name of ['pre-commit', 'commit-msg']) {
    const argument = name === 'commit-msg' ? ' "$1"' : '';
    writeFileSync(join(hooks, name), `#!/bin/sh\necho ${name} >> "${marks}"\nPULLBOARD_HOOK_STATIC= exec "${process.execPath}" "${BIN}" hook ${name}${argument}\n`);
    chmodSync(join(hooks, name), 0o755);
  }
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
  return () => existsSync(marks) ? readFileSync(marks, 'utf8').trim().split('\n') : [];
}

/** Observe one helper on a fresh private real repository, keeping partial staging and ignored/untracked bytes. */
async function observe(t, enable, refused, legacy) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  const cwd = refused ? box.web : box.repo;
  const starts = spyHooks(box);
  const partial = join(cwd, 'partial.txt');
  writeFileSync(partial, 'staged bytes\n'); chmodSync(partial, 0o755);
  box.git(cwd, 'add', 'partial.txt');
  writeFileSync(partial, 'unstaged bytes\n');
  writeFileSync(join(cwd, 'untracked.bin'), Buffer.from([0, 255, 17]));
  const beforeHead = box.git(cwd, 'rev-parse', 'HEAD').trim();
  const beforeIndex = box.git(cwd, 'ls-files', '--stage', 'partial.txt');
  const calls = [], actual = box.tryGitInProcess;
  const measured = { ...box, repo: cwd };
  for (const name of ['tryGit', 'tryGitInProcess']) {
    measured[name] = async (...args) => {
      const started = performance.now();
      const result = await (name === 'tryGitInProcess' && !legacy ? actual : box.tryGit)(...args);
      calls.push({ operation: name, ms: performance.now() - started, status: result.status });
      return result;
    };
  }
  let failure;
  const started = performance.now();
  try { await enable(measured); } catch (error) { failure = error; }
  const elapsedMs = performance.now() - started;
  assert.equal(calls.length, 1, 'the helper attempts exactly one commit');
  const result = calls[0], external = starts();
  t.diagnostic(JSON.stringify({ helper: enable.name, refused, legacy, elapsedMs, calls, external }));
  assert.equal(result.status !== 0, refused, failure?.message);
  if (refused) assert.equal(failure?.code, 'ERR_ASSERTION', 'the helper retains its hook refusal assertion');
  else assert.equal(failure, undefined);
  assert.equal(readFileSync(partial, 'utf8'), 'unstaged bytes\n');
  assert.deepEqual(readFileSync(join(cwd, 'untracked.bin')), Buffer.from([0, 255, 17]));
  assert.equal(box.git(cwd, 'ls-files', '--stage', 'partial.txt'), beforeIndex, 'staged blob and executable mode survive');
  assert.equal(box.git(cwd, 'rev-parse', 'HEAD').trim() === beforeHead, refused);
  const configIndex = box.git(cwd, 'show', ':pullboard.json');
  assert.equal(JSON.parse(configIndex).worktreeMaintenance.enabled, true, 'the intended config is staged even on refusal');
  if (!refused) {
    assert.equal(box.git(cwd, 'show', 'HEAD:pullboard.json'), configIndex, 'successful setup commits the intended config');
    assert.equal(box.tryGit(cwd, 'show', 'HEAD:partial.txt').stdout, 'staged bytes\n', 'Git commits staged rather than working bytes');
  }
  return { status: result.status, stderr: parityText(failure?.message ?? '', box.dir), external };
}

/** Pair the pre-fix real-hook route with the actual helper without changing feature defaults. */
async function pair(t, enable, refused) {
  const before = await observe(t, enable, refused, true);
  const after = await observe(t, enable, refused, false);
  assert.equal(after.status, before.status);
  assert.equal(after.stderr, before.stderr, 'the actual success or refusal remains observable');
  assert.deepEqual(before.external, refused ? ['pre-commit'] : ['pre-commit', 'commit-msg']);
  assert.deepEqual(after.external, [], 'configured in-process setup starts no duplicate external hooks');
}

test('cli.io-worktree-maintenance-setup-hooks.maintenance-success: maintenance opt-in preserves Git writes without duplicate hooks [C7,#12968]', async t => {
  await pair(t, enableMaintenance, false);
});
test('cli.io-worktree-maintenance-setup-hooks.maintenance-refusal: maintenance opt-in preserves refused hooks and staged metadata [C7,#12968]', async t => {
  await pair(t, enableMaintenance, true);
});
test('cli.io-worktree-maintenance-setup-hooks.lifecycle-success: lifecycle opt-in preserves Git writes without duplicate hooks [C7,#12968]', async t => {
  await pair(t, enableLifecycle, false);
});
test('cli.io-worktree-maintenance-setup-hooks.lifecycle-refusal: lifecycle opt-in preserves refused hooks and staged metadata [C7,#12968]', async t => {
  await pair(t, enableLifecycle, true);
});
