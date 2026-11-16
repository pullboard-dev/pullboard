/** A census write of the file-times record drops untracked files and plans by the lower of two samples; landing writes merge as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';
import { fileTimesPath } from '../../../index.js';
import { readFileTimes } from '../../../index.js';
import { readFileSamples } from '../../../index.js';
import { writeFileTimes } from '../../../index.js';
import { landingBalance } from '../../../index.js';
import { planLandingShards } from '../../../index.js';
import { describeSetting } from '../../../../config/index.js';

/** A private git repository whose common dir holds the record. */
function repo(t) {
  const box = privateFixtureFiles('pullboard-file-times-census-');
  const root = join(box.root, 'repo');
  mkdirSync(root);
  box.write('repo/a.test.js', '\n');
  fixtureCommitAll(root);
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  return root;
}

const record = root => JSON.parse(readFileSync(fileTimesPath(root), 'utf8'));

test('clause 1: with census.recordFileTimes on, a census write leaves no entry for a file absent from that census file list [C7]', (t) => {
  const root = repo(t);
  writeFileTimes(root, { 'a.test.js': 1000, 'gone.test.js': 788_000, 'b.test.js': 2000 });
  writeFileTimes(root, { 'a.test.js': 1200 }, { keep: ['a.test.js', 'b.test.js'] });
  assert.deepEqual(Object.keys(readFileTimes(root)).sort(), ['a.test.js', 'b.test.js']);
  assert.equal(readFileTimes(root)['b.test.js'], 2000, 'a kept file the census did not time keeps its weight');
  assert.ok(!Object.hasOwn(record(root).samples, 'gone.test.js'));
});

test('clause 2: the plan weight of a file measured at 22 s and then 363 s is 22 s, and the record keeps both samples [C7]', (t) => {
  const root = repo(t);
  const keep = ['queue/freshness.test.js', 'a.test.js'];
  writeFileTimes(root, { 'queue/freshness.test.js': 22_000, 'a.test.js': 5000 }, { keep });
  writeFileTimes(root, { 'queue/freshness.test.js': 363_000, 'a.test.js': 4000 }, { keep });
  assert.equal(readFileTimes(root)['queue/freshness.test.js'], 22_000);
  assert.deepEqual(readFileSamples(root)['queue/freshness.test.js'], [22_000, 363_000]);
  assert.equal(readFileTimes(root)['a.test.js'], 4000);
  // The planner reads the lower sample, so one loaded run does not swell the file's job.
  const times = readFileTimes(root);
  assert.equal(landingBalance(keep, times), 'history');
  assert.deepEqual(planLandingShards(keep, 1, times, root).map(shard => shard.weight), [26_000]);
  // A third sample pushes the oldest out: the last two only.
  writeFileTimes(root, { 'queue/freshness.test.js': 90_000 }, { keep });
  assert.deepEqual(readFileSamples(root)['queue/freshness.test.js'], [363_000, 90_000]);
  assert.equal(readFileTimes(root)['queue/freshness.test.js'], 90_000);
});

test('clause 3: with census.recordFileTimes off (the default) and for landing writes, writeFileTimes merges exactly as on main, and census.recordFileTimes is a described setting [C7]', (t) => {
  const root = repo(t);
  writeFileTimes(root, { 'a.test.js': 1000, 'gone.test.js': 9000 });
  writeFileTimes(root, { 'a.test.js': 363_000 });
  assert.deepEqual(record(root), { version: 1, files: { 'a.test.js': 363_000, 'gone.test.js': 9000 } });
  const described = describeSetting('census.recordFileTimes');
  assert.ok(described, 'census.recordFileTimes has a description');
  assert.match(described.description, /lower of its last two/u);
  assert.equal(described.unit, 'on/off');
});
