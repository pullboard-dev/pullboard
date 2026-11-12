/**
 * A claim freezes the criterion with one git read of the committed files, counted by the spawn recorder on a small board [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

/** The logged git children the claim freeze started to read committed blobs: a show or a cat-file under freezer.js. */
function blobReads(log) {
  return readFileSync(log, 'utf8').split('\n').filter((line) => line.split(' ')[2] === 'git' && line.split(' ')[3].match(/^(show|cat-file)$/u) && line.includes('freezer.js'));
}

test('claim freeze makes one git read [C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Freeze one', diagnose: false, args: ['--specs', 'G1'] }).item_id;
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  const result = box.run(box.web, 'claim', String(item), '--json');
  assert.equal(result.code, 0, `claim: ${result.err}${result.out}`);
  console.log(`# claim spawns:\n${readFileSync(log, 'utf8')}`);
  const reads = blobReads(log);
  assert.ok(reads.length <= 1, `claim read committed files ${reads.length} times:\n${reads.join('\n')}`);
});
