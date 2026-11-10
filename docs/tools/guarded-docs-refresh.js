#!/usr/bin/env node
/** Prove post-landing generated documentation in isolation before advancing main [A5,C7,B3]. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERATED_DOC_PATHS } from '../../packages/merge/light.js';
import { DEFAULT_FILE_WALL_MS } from '../../packages/drive/light.js';

const root = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'pullboard-docs-refresh-'));
const checkout = join(directory, 'candidate');
let added = false;
/** Run an exact command without a shell; forward its diagnostics to the operator. */
function run(cwd, program, args, quiet = false) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // A parent test runner must not silently skip either nested guard.
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (!quiet) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
  return result;
}
function git(cwd, ...args) { return run(cwd, 'git', args, true); }
/** Put the failed test and its first error line ahead of lengthy TAP location metadata. */
function tapFailure(output) {
  const block = output?.match(/^\s*not ok\b[^\n]*(?:\n(?!\s*\.\.\.\s*$)[^\n]*)*/mu)?.[0];
  if (!block) return '';
  const name = block.split('\n')[0].trim();
  const error = block.match(/^\s*error:\s*(?:[|>]-?\s*\n\s*([^\n]+)|([^\n]+))/mu);
  return [name, error?.[1] ?? error?.[2]].filter(Boolean).join(': ');
}
function requireSuccess(result, phase) {
  if (result.status !== 0) {
    const tap = tapFailure(result.stdout);
    const detail = result.error?.message || tap?.trim() || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${phase}: ${detail.replace(/\s+/gu, ' ')}`);
  }
}
/** On every failed guard, notify the board and leave the original main untouched. */
function refuse(phase, error) {
  const message = `post-landing docs refresh refused at ${phase}: ${error.message}`.slice(0, 350);
  process.stderr.write(`${message}\n`);
  const notice = run(root, process.execPath, ['apps/cli/pullboard.js', 'shout', 'all', message]);
  if (notice.status !== 0) process.stderr.write('board shout failed; report the refusal manually\n');
}
let phase = 'setup';
try {
  const branch = git(root, 'branch', '--show-current');
  requireSuccess(branch, phase);
  if (branch.stdout.trim() !== 'main') throw new Error('run from the main checkout');
  const clean = git(root, 'status', '--porcelain', '--untracked-files=all');
  requireSuccess(clean, phase);
  if (clean.stdout.trim()) throw new Error('main checkout must be clean');
  const base = git(root, 'rev-parse', 'HEAD'); requireSuccess(base, phase);
  const opened = git(root, 'worktree', 'add', '--detach', checkout, base.stdout.trim()); requireSuccess(opened, phase); added = true;
  phase = 'generate'; requireSuccess(run(checkout, process.execPath, ['docs/tools/update-docs.js']), phase);
  phase = 'generation scope';
  const changed = git(checkout, 'diff', '--name-only', 'HEAD'); requireSuccess(changed, phase);
  if (changed.stdout.trim().split('\n').filter(Boolean).some(file => !GENERATED_DOC_PATHS.includes(file))) throw new Error('generator changed a non-generated file');
  const extra = git(checkout, 'ls-files', '--others', '--exclude-standard'); requireSuccess(extra, phase);
  if (extra.stdout.trim()) throw new Error('generator created untracked files');
  const snapshot = git(checkout, 'diff', '--binary', 'HEAD'); requireSuccess(snapshot, phase);
  phase = 'formats guard'; requireSuccess(run(checkout, process.execPath, ['--test', `--test-timeout=${DEFAULT_FILE_WALL_MS}`, 'docs/formats.test.js']), phase);
  phase = 'docs guard'; requireSuccess(run(checkout, process.execPath, ['docs/tools/update-docs.js', '--check']), phase);
  phase = 'guard integrity';
  const after = git(checkout, 'diff', '--binary', 'HEAD'); requireSuccess(after, phase);
  const remaining = git(checkout, 'ls-files', '--others', '--exclude-standard'); requireSuccess(remaining, phase);
  const staged = git(checkout, 'diff', '--cached', '--quiet');
  if (after.stdout !== snapshot.stdout || remaining.stdout.trim() || staged.status !== 0) throw new Error('a guard changed the generated tree');
  phase = 'stage'; requireSuccess(git(checkout, 'add', '--', ...GENERATED_DOC_PATHS), phase);
  const diff = git(checkout, 'diff', '--cached', '--quiet');
  if (diff.status === 0) { process.stdout.write('generated documentation is already current\n'); }
  else {
    if (diff.status !== 1) requireSuccess(diff, phase);
    phase = 'commit'; requireSuccess(git(checkout, 'commit', '-m', 'docs: regenerate generated docs after the landing [C7]'), phase);
    const tip = git(checkout, 'rev-parse', 'HEAD'); requireSuccess(tip, phase);
    phase = 'advance';
    const current = git(root, 'rev-parse', 'HEAD'); requireSuccess(current, phase);
    const stillClean = git(root, 'status', '--porcelain', '--untracked-files=all'); requireSuccess(stillClean, phase);
    if (current.stdout.trim() !== base.stdout.trim() || stillClean.stdout.trim()) throw new Error('main moved or became dirty while guards ran');
    requireSuccess(git(root, 'merge', '--ff-only', tip.stdout.trim()), phase);
    process.stdout.write(`landed guarded generated documentation ${tip.stdout.trim()}\n`);
  }
} catch (error) { refuse(phase, error); process.exitCode = ({ generate: 2, 'formats guard': 3, 'docs guard': 4 })[phase] ?? 1; }
finally {
  if (added) { const removed = git(root, 'worktree', 'remove', '--force', checkout); if (removed.status !== 0) { process.stderr.write(`cannot remove temporary worktree ${checkout}: ${removed.stderr}\n`); process.exitCode = 1; } }
  rmSync(directory, { recursive: true, force: true });
}
