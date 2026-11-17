/** With census.soloFileSeconds set, a file recorded slower than that plans as a census job to itself; unset, the plan is unchanged [C7,#9499]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { censusPlan } from '../../src/logic/census.js';

const FILES = Array.from({ length: 30 }, (_, index) => `dir/f${String(index).padStart(2, '0')}.test.js`);
const SLOW = ['dir/slow-a.test.js', 'dir/slow-b.test.js'];
const ALL = [...FILES, ...SLOW];
const TIMES = { ...Object.fromEntries(FILES.map((file, index) => [file, (index % 5 + 1) * 10_000])), 'dir/slow-a.test.js': 300_000, 'dir/slow-b.test.js': 121_000 };
const base = (list = ALL) => [{ files: [...list], weight: 1 }];

test('clause 1: with census.soloFileSeconds set to 120, each file recorded over 120 s is a one-file job and no other file shares it [C7,#9499]', () => {
  for (const [balance, minutes] of [[false, null], [true, null], [false, 3]]) {
    const jobs = censusPlan(ALL, 4, TIMES, balance, base, minutes, 120);
    for (const file of SLOW) assert.ok(jobs.some(job => job.files.length === 1 && job.files[0] === file), `${file} runs alone (balance ${balance}, minutes ${minutes})`);
    assert.deepEqual(jobs.flatMap(job => job.files).sort(), [...ALL].sort(), 'every file runs once');
    assert.deepEqual(jobs.map(job => job.weight), jobs.map(job => job.weight).sort((a, b) => b - a), 'heaviest first');
  }
  const exact = censusPlan(['dir/a.test.js', 'dir/b.test.js'], 2, { 'dir/a.test.js': 120_000, 'dir/b.test.js': 120_001 }, true, base, null, 120);
  assert.ok(exact.some(job => job.files.length === 1 && job.files[0] === 'dir/b.test.js'), 'a file at exactly the limit is not solo, one over is');
});

test('clause 2: with census.soloFileSeconds unset the plan is exactly what it was [C7,#9499]', () => {
  for (const [balance, minutes] of [[false, null], [true, null], [false, 3]]) {
    const without = censusPlan(ALL, 4, TIMES, balance, base, minutes);
    assert.deepEqual(censusPlan(ALL, 4, TIMES, balance, base, minutes, null), without, `null leaves the plan alone (balance ${balance}, minutes ${minutes})`);
  }
  assert.deepEqual(censusPlan(ALL, 4, TIMES, false, base), base(), 'the landing planner still decides');
  assert.deepEqual(censusPlan(ALL, 4, TIMES, true, base, null, 600), censusPlan(ALL, 4, TIMES, true, base), 'a limit above every file changes nothing');
});
