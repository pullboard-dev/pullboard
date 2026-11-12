/** One pullboard pre-commit hook run in a claimed worktree starts at most 12 git processes [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: pre-commit starts at most 12 git processes under a git-counting PATH shim [C7]', { timeout: 60_000 }, () => {
  const box = helpers.project();
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Hook spawns', '--specs', 'G1').code, 0);
  box.env.CODEX_SESSION_ID = 'hook-spawns-6197';
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const bin = join(box.dir, 'git-count');
  const log = join(bin, 'calls.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  const real = box.env.PATH.split(':').map(dir => join(dir, 'git')).find(path => { try { return readFileSync(path).length > 0 && path !== join(bin, 'git'); } catch { return false; } });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.html'), 'one line\n');
  box.git(box.web, 'add', '-A');
  const path = box.env.PATH;
  let result;
  box.env.PATH = `${bin}:${path}`;
  try { result = box.run(box.web, 'hook', 'pre-commit'); } finally { box.env.PATH = path; }
  assert.equal(result.code, 0, result.err);
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length <= 12, `pre-commit started ${calls.length} git processes:\n${calls.join('\n')}`); // budget: frozen #6197 clause 1 permits 12, down from 33.
});
