/** One claim reads the trunk config and the worktree list once each, counted by the spawn counter [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

test('claim reads trunk config and worktree list once [C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Folder spawns', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  const claim = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.err + claim.out);
  const lines = readFileSync(log, 'utf8').split('\n').filter((line) => /\bgit\b/u.test(line.split(' ')[2] ?? ''));
  const trunk = lines.filter((line) => /\bconfig\b.*\bpullboard\.trunk\b/u.test(line));
  const trees = lines.filter((line) => /\bworktree list\b/u.test(line));
  assert.ok(trunk.length <= 1, `claim read pullboard.trunk ${trunk.length} times:\n${trunk.join('\n')}`);
  assert.ok(trees.length <= 1, `claim ran worktree list ${trees.length} times:\n${trees.join('\n')}`);
});
