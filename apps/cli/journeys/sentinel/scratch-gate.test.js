/** The gate's throwaway folders are created under the scratch root [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBaseline } from '../../../../packages/gate/src/io/check/baseline.js';
import { runShell } from '../../../../packages/gate/src/io/run/shell.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';

/** Runs the body with PULLBOARD_SCRATCH set (or cleared), then restores it. */
function withScratch(value, body) {
  const before = process.env.PULLBOARD_SCRATCH;
  if (value === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = value;
  try { return body(); } finally { if (before === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = before; }
}

/** A private scratch folder and a one-commit repo to run against. */
function fixture(t) {
  const { root } = privateFixtureFiles('pullboard-scratch-gate-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scratch'));
  const scratch = realpathSync(join(root, 'scratch'));
  const repo = temporaryRepository(t, 'pullboard-scratch-gate-repo-');
  return { scratch, repo, head: runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo }) };
}

test('with scratch set, check-baseline, timed-shell and shell pipe folders are created under it [C7]', t => {
  const { scratch, repo, head } = fixture(t);
  const listing = `ls "${scratch}" | cat`;
  const shell = withScratch(scratch, () => runShell(repo, listing, { stages: true, timeoutMs: 60_000 }));
  assert.match(shell.output, /pullboard-pipes-/u);
  assert.match(shell.output, /pullboard-timed-output-/u);
  assert.match(shell.output, /pullboard-timed-shell-/u);
  const where = join(scratch, '..', 'where.txt');
  const baseline = withScratch(scratch, () => checkBaseline(repo, `dirname "$PWD" > "${where}"`, { main: head }));
  assert.equal(baseline.result, 'green');
  assert.match(readFileSync(where, 'utf8').trim(), new RegExp(`^${scratch}/pullboard-check-base-`, 'u'));
});

test('with scratch unset, the gate folders are os.tmpdir() folders as before [C7]', t => {
  const { repo } = fixture(t);
  const shell = withScratch(undefined, () => runShell(repo, `ls "${tmpdir()}" | cat`, { stages: true }));
  assert.match(shell.output, /pullboard-pipes-/u);
});
