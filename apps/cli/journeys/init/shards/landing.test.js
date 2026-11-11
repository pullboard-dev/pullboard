/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  configProblems,
  defaults,
} from '../../../../../packages/config/index.js';
import { landingShardCount } from '../../../../../packages/gate/index.js';
import {
  landingBalance,
  landingFloor,
  planLandingShards,
  shardFileTimes,
} from '../../../../../packages/landing/index.js';
import {
  HOST,
  NAMES,
  git,
  fixture,
  scenario,
  landingGate,
  mergedFiles,
  marks,
} from '../../../tests/fixtures/init/shards.js';

test('a landing gate split into shards reports one result [C7,V4]', { timeout: 300_000 }, async (t) => { // budget: three bounded landing scenarios on one fixture.
  // The planner: no times balances by count; known times put the heavy files on their own shards.
  const six = NAMES.map(name => `./test/${name}.test.js`);
  assert.deepEqual(planLandingShards(six, 3).map(shard => shard.files.length), [2, 2, 2]);
  const weighted = planLandingShards(six, 3, { 'test/a.test.js': 900, 'test/b.test.js': 800, 'test/c.test.js': 100, 'test/d.test.js': 100, 'test/e.test.js': 100, 'test/f.test.js': 100 });
  assert.deepEqual(weighted.map(shard => shard.files), [['./test/a.test.js'], ['./test/b.test.js'], ['./test/c.test.js', './test/d.test.js', './test/e.test.js', './test/f.test.js']]);
  assert.equal(landingBalance(six), 'file count', 'with no history the plan names its file-count fallback');
  assert.equal(landingBalance(six, { 'test/a.test.js': 900 }), 'history and average');
  assert.equal(landingBalance(six, Object.fromEntries(NAMES.map(name => [`test/${name}.test.js`, 10]))), 'history');
  assert.deepEqual(landingFloor(six, { 'test/a.test.js': 900, 'test/b.test.js': 50 }), { path: 'test/a.test.js', ms: 900 });
  assert.equal(landingFloor(six), null);
  assert.deepEqual(shardFileTimes('# landing-file-ms 42 test/a.test.js\nnoise\n'), { 'test/a.test.js': 42 });
  assert.equal(configProblems({ ...defaults(), landingShards: 0 }).some(problem => problem.includes('"landingShards"')), true);
  assert.deepEqual(configProblems({ ...defaults(), landingShards: 3 }), []);

  const box = fixture();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  assert.equal(landingShardCount(box.repo), 3);

  // Green: three shards, one of them on the runner, every file once, one green result.
  scenario(box, 'green');
  const green = await landingGate(box, 'green', 120_000);
  assert.equal(green.isGreen, true, green.output);
  const files = mergedFiles(green.output);
  assert.deepEqual(Object.keys(files).sort(), NAMES.map(name => `test/${name}.test.js`));
  assert.deepEqual([...new Set(Object.values(files).map(file => file.shard))].sort(), ['1/3', '2/3', '3/3']);
  assert.ok(Object.values(files).some(file => file.host === HOST), `one shard runs on the registered runner\n${green.output}`);
  assert.ok(Object.values(files).some(file => file.host === 'local'), 'the others run on local slots');
  assert.match(green.output, /^# landing result: green$/mu);
  assert.match(green.output, /^# landing shards: 3 balanced by file count \(/mu, 'the first landing has no history');
  assert.equal(green.profile.landingShards.balance, 'file count');
  assert.equal(green.profile.landingShards.files.length, 6, 'the profile names every file once');
  assert.ok(green.profile.landingShards.files.every(file => file.shard && file.host));
  assert.equal(green.profile.landingShards.shards.filter(shard => shard.status === 'green').length, 3);
  assert.equal(marks(box, '.finished').length, 6);
  // Every file's measured wall time is kept, so the next landing balances by real history.
  const history = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'landing-file-times.json'), 'utf8'));
  assert.deepEqual(Object.keys(history.files).sort(), NAMES.map(name => `test/${name}.test.js`));
  assert.ok(Object.values(history.files).every(ms => Number.isFinite(ms) && ms > 0), 'each file has a measured wall time');
  assert.ok(green.profile.landingShards.files.every(file => Number.isFinite(file.durationMs) && file.durationMs > 0));

  // One failing file: the gate goes red and the other shards are stopped, long before their files end.
  scenario(box, 'fail');
  const red = await landingGate(box, 'failing shard', 60_000);
  assert.notEqual(red.collectAllComplete,true,'cancelled failfast siblings never establish full collection');
  assert.equal(red.isGreen, false, red.output);
  assert.match(red.output, /^# landing shard \d\/3 attempt 1 on \S+: red in \d+ ms(?: \(.*\))?$/mu);
  assert.equal([...red.output.matchAll(/^# landing shard \d\/3 attempt \d+ on \S+: stopped in \d+ ms(?: \(.*\))?$/gmu)].length, 2, red.output);
  // A test failure is not infrastructure: nothing reruns and nothing falls back.
  assert.doesNotMatch(red.output, /rerunning shard|infrastructure/u);
  assert.equal(red.profile.landingShards.shards.length, 3, 'one attempt per shard');
  assert.match(red.output, /^# landing result: red, first failure in shard \d\/3$/mu);
  assert.match(red.output, /^# landing shards: 3 balanced by history \(/mu, 'the second landing balances by the first one\'s wall times');
  assert.match(red.output, /^# landing floor: \d+ ms test\/[a-f]\.test\.js$/mu, 'the slowest recorded file is named as the floor');
  assert.equal(green.profile.landingShards.floor, null, 'with no history there is no floor yet');
  assert.ok(red.profile.landingShards.floor.ms > 0);
  // Every other file sleeps far past this scenario's deadline, so none finishing means each was stopped.
  assert.deepEqual(marks(box, '.finished'), [], 'no stopped file ran to its end');

  // A shard that fails after the others went green still makes the whole landing red.
  scenario(box, 'late-fail');
  const late = await landingGate(box, 'late failing shard', 60_000);
  assert.equal(late.isGreen, false, late.output);
  assert.ok(late.profile.landingShards.shards.some(shard => shard.status === 'green'), `another shard was green first\n${late.output}`);
  assert.equal(late.profile.landingShards.shards.filter(shard => shard.status === 'red').length, 1);

});
