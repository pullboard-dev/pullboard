/** With census.selfTune on, a pulled census with no census.jobMinutes sizes its jobs from the previous census's shard times [C7,U151]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { censusJobMinutesFrom } from '../../../src/io/test/census.js';
import { selfTunedJobMinutes } from '../../../src/logic/census-tune.js';
import { previousShardMs } from '../../../src/logic/census.js';

const MIN = 60_000;
const START = Date.parse('2026-11-15T10:00:00.000Z');

/** One census row per shard, each shard `minutes` long, as a census writes them. */
function rowsOf(minutes) {
  return minutes.map((long, at) => ({ file: `f${at}.test.js`, status: 'green', shard: `${at + 1}/${minutes.length}`, startedAt: new Date(START).toISOString(), endedAt: new Date(START + long * MIN).toISOString() }));
}

/** A census folder holding the given earlier censuses (oldest first) and an empty own file. */
function folder(t, earlier) {
  const box = privateFixtureFiles('pullboard-selftune-');
  const dir = join(box.root, 'census');
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  earlier.forEach((rows, at) => {
    const path = join(dir, `old${at}.jsonl`);
    writeFileSync(path, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
    utimesSync(path, new Date(START + at * 1000), new Date(START + at * 1000));
  });
  const out = join(dir, 'now.jsonl');
  writeFileSync(out, '');
  return { dir, out };
}

test('clause 1: with census.selfTune on, no typed census.jobMinutes and a previous census, the jobs are cut at selfTunedJobMinutes of its shard times [C7,U151]', t => {
  const shards = [4, 5, 6, 7, 8];
  const { dir, out } = folder(t, [rowsOf([1, 1, 1, 1]), rowsOf(shards)]);
  const minutes = censusJobMinutesFrom(dir, out, { selfTune: true, typed: null });
  assert.equal(minutes, selfTunedJobMinutes(shards.map(long => long * MIN)), 'the newest census decides');
  assert.equal(minutes, 7);
});

test('clause 1: a typed census.jobMinutes wins over the self-tuned length [C7,U151]', t => {
  const { dir, out } = folder(t, [rowsOf([4, 5, 6, 7, 8])]);
  assert.equal(censusJobMinutesFrom(dir, out, { selfTune: true, typed: 12 }), 12);
});

test('clause 2: with census.selfTune off the plan is today\'s, with no length [C7,U151]', t => {
  const { dir, out } = folder(t, [rowsOf([4, 5, 6, 7, 8])]);
  assert.equal(censusJobMinutesFrom(dir, out, { selfTune: false, typed: null }), null);
});

test('clause 2: with no previous census, too few shards, or a census without instants the plan is today\'s [C7,U151]', t => {
  assert.equal(censusJobMinutesFrom(folder(t, []).dir, 'nowhere.jsonl', { selfTune: true, typed: null }), null, 'no earlier census');
  const few = folder(t, [rowsOf([4, 5, 6])]);
  assert.equal(censusJobMinutesFrom(few.dir, few.out, { selfTune: true, typed: null }), null, 'three shards say too little');
  const bare = folder(t, [rowsOf([4, 5, 6, 7, 8]).map(({ shard, file, status }) => ({ shard, file, status }))]);
  assert.equal(censusJobMinutesFrom(bare.dir, bare.out, { selfTune: true, typed: null }), null, 'no instants recorded');
  assert.equal(censusJobMinutesFrom('/pullboard-no-such-census-dir', 'x.jsonl', { selfTune: true, typed: null }), null, 'no folder');
});

test('clause 1: a shard\'s time is its widest end minus start, one per shard label [C7,U151]', () => {
  const rows = [...rowsOf([3, 9]), { shard: '1/2', startedAt: new Date(START).toISOString(), endedAt: new Date(START + 5 * MIN).toISOString() }];
  assert.deepEqual(previousShardMs(rows).sort((a, b) => a - b), [5 * MIN, 9 * MIN]);
});
