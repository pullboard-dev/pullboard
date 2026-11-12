/** Landing, merge, spec and rigor throwaway folders are created under the scratch root [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLandingCliSmoke } from '../../../../packages/landing/index.js';
import { runCheckAt } from '../../../../packages/rigor/index.js';
import { verifySignature } from '../../../../packages/spec/index.js';
import { parseProcessCensus } from '../../../../packages/kernel/src/logic/census.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';

/** The folder's path with its parent resolved: the folder itself may be gone by the time it is checked. */
function resolved(folder) {
  return join(realpathSync(dirname(folder)), basename(folder));
}

/** Runs the body with PULLBOARD_SCRATCH set (or cleared), then restores it. */
async function withScratch(value, body) {
  const before = process.env.PULLBOARD_SCRATCH;
  if (value === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = value;
  try { return await body(); } finally { if (before === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = before; }
}

/** A private box with an empty scratch folder inside it. */
function box(t) {
  const { root } = privateFixtureFiles('pullboard-scratch-landing-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  return { root, scratch: realpathSync(scratch) };
}

/** Runs the landing smoke with a launcher that records where it was told to work, then refuses. */
function smokeFolder(candidate) {
  const seen = [];
  const git = (args, options) => { seen.push(options.cwd); return { status: 1, stderr: 'stop' }; };
  assert.throws(() => runLandingCliSmoke(candidate, { git }), { code: 'LAND_CLI_SMOKE' });
  return seen[0];
}

/** A candidate checkout the smoke will start in. */
function candidate(root) {
  const folder = join(root, 'candidate');
  mkdirSync(join(folder, 'apps/cli'), { recursive: true });
  writeFileSync(join(folder, 'apps/cli/pullboard.js'), '');
  return folder;
}

/** A fake ssh-keygen on PATH that records its arguments and succeeds. */
function fakeKeygen(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'keygen.log');
  writeFileSync(join(bin, 'ssh-keygen'), `#!/bin/sh\necho "$@" > "${log}"\nexit 0\n`);
  chmodSync(join(bin, 'ssh-keygen'), 0o755);
  return { bin, log };
}

test('with scratch set, landing smoke, rigor proof and spec signature folders are created under it [C7]', async t => {
  const { root, scratch } = box(t);
  const folder = await withScratch(scratch, () => smokeFolder(candidate(root)));
  assert.ok(folder.startsWith(`${scratch}/pullboard-landing-smoke-`), folder);
  const { bin, log } = fakeKeygen(root);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  await withScratch(scratch, () => verifySignature({ by: 'me', signature: 'sig' }, 'allowed'));
  assert.match(readFileSync(log, 'utf8'), new RegExp(`${scratch}/pullboard-verify-`, 'u'));
  const repo = temporaryRepository(t, 'pullboard-scratch-rigor-');
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
  const run = await withScratch(scratch, () => runCheckAt(repo, head, 'unused', { executable: process.execPath, args: ['-e', 'console.log(process.cwd())'] }, { parseProcessCensus }));
  assert.ok(resolved(run.stdout.trim()).startsWith(`${scratch}/pullboard-rigor-proof-`), run.stdout);
});

test('with scratch unset, the folders are os.tmpdir() folders as before [C7]', async t => {
  const { root } = box(t);
  const folder = await withScratch(undefined, () => smokeFolder(candidate(root)));
  assert.ok(resolved(folder).startsWith(join(realpathSync(tmpdir()), 'pullboard-landing-smoke-')), folder);
});
