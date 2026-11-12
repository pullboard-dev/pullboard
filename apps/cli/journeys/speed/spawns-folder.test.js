/** One claim reads the trunk config and the worktree list once each, counted under a git-counting PATH shim [C7]. */
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
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('claim reads trunk config and worktree list once [C7]', { timeout: 60_000 }, async () => {
  const box = helpers.project('true');
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Folder spawns', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  box.env.CODEX_SESSION_ID = 'folder-spawns-6167';
  const bin = join(box.dir, 'git-count');
  const log = join(bin, 'calls.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  const real = box.env.PATH.split(':').map(dir => join(dir, 'git')).find(path => { try { return readFileSync(path).length > 0 && path !== join(bin, 'git'); } catch { return false; } });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const claim = await runCliInProcess(['claim', String(id)], { cwd: box.web, env: { ...box.env, PATH: `${bin}:${box.env.PATH}` } });
  assert.equal(claim.code, 0, claim.err);
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const trunk = calls.filter(call => /\bconfig\b.*\bpullboard\.trunk\b/u.test(call));
  const trees = calls.filter(call => /\bworktree list\b/u.test(call));
  assert.ok(trunk.length >= 1, `the shim saw no trunk read in ${calls.length} git calls`);
  assert.ok(trunk.length <= 1, `claim read pullboard.trunk ${trunk.length} times:\n${trunk.join('\n')}`);
  assert.ok(trees.length <= 1, `claim ran worktree list ${trees.length} times:\n${trees.join('\n')}`);
});
