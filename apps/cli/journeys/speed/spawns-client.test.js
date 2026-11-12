/**
 * The client and resident start of one next learn the tool build in one git call, counted by the spawn recorder on a small board [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

/** The logged git children that learn the tool build: a rev-parse, a show of the board config, or an ls-tree. */
function buildReads(log) {
  return readFileSync(log, 'utf8').split('\n').filter((line) => /^\S+ \S+ git /u.test(line) && /\s(rev-parse|show|ls-tree|cat-file)\s/u.test(line.replace(/^\S+\s+\S+\s+\S+/u, '')));
}

test('next start learns the tool build in one git call [C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Client one', diagnose: false, args: ['--specs', 'G1'] });
  Object.assign(box.env, spawnEnv(log));
  writeFileSync(log, '');
  const result = box.run(box.web, 'next', '--build', '--json');
  assert.equal(result.code, 0, `next: ${result.err}${result.out}`);
  console.log(`# next spawns:\n${readFileSync(log, 'utf8')}`);
  const reads = buildReads(log);
  assert.ok(reads.length <= 1, `next learned the tool build with ${reads.length} git calls:\n${reads.join('\n')}`);
});
