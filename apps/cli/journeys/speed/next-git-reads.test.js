/** With next.oneGitRead on, the git status, rev-parse and rev-list reads of next's selection each run once per command and next picks and prints what it does with the setting off [C7,#9853,#5329]. @pullboard-test-input source-cell apps/cli packages/store packages/config */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

const READS = new Set(['status', 'rev-parse', 'rev-list']);

/** Write next.oneGitRead into the fixture machine's settings, or leave it unset when `value` is undefined. */
function setting(box, value) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let known = {};
  try { known = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fresh machine has no settings yet. */ }
  if (value !== undefined) known.next = { ...known.next, oneGitRead: value };
  writeFileSync(file, JSON.stringify(known));
}

/** The three reads among the git children a spawn log holds, as `subcommand args <- callers`; git's -C path pair is skipped. */
function readLines(log) {
  const lines = [];
  for (const part of readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split(' '))) {
    if (!part[2] || !part[2].endsWith('git')) continue;
    const args = part.slice(3);
    while (args[0] === '-C') args.splice(0, 2);
    if (READS.has(args[0])) lines.push(args.join(' '));
  }
  return lines;
}

/** One `next --build` on a fresh large board with the setting at `value`: the item it handed out, what it printed and its git reads. */
async function measured(t, value) {
  const box = largeBoard(t, { scale: { items: 2_500, events: 5_000, shouts: 1_000, seats: 100 } });
  const log = join(box.dir, 'spawns.log');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Git reads sample', diagnose: false, args: ['--specs', 'G1'] });
  setting(box, value);
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  const result = await box.runLocal(box.web, 'next', '--build', '--json');
  assert.equal(result.code, 0, `next exited ${result.code}: ${result.err}${result.out}`);
  const answer = JSON.parse(result.out);
  const printed = (result.out + result.err).replaceAll(box.dir, '<box>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/gu, '<time>');
  const spawned = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  console.log(`# next children spawned: ${spawned}`);
  return { item: answer?.item?.item_id ?? answer?.item_id, printed, reads: readLines(log) };
}

test('clause 1: with next.oneGitRead on, next spawns fewer status, rev-parse and rev-list reads than with it off [C7,#9853]', async (t) => {
  const off = await measured(t, false);
  const on = await measured(t, true);
  console.log(`# next git reads off: ${off.reads.length}; on: ${on.reads.length}`);
  for (const line of off.reads) console.log(`# off ${line}`);
  for (const line of on.reads) console.log(`# on ${line}`);
  assert.ok(on.reads.length <= off.reads.length, 'the setting never adds a read');
  assert.ok(on.reads.length < off.reads.length, `fewer reads with it on (${on.reads.length}) than off (${off.reads.length})`);
});

test('clause 2: next hands out the same item and prints the same lines with next.oneGitRead on and off [C7,#9853]', async (t) => {
  const off = await measured(t, false);
  const on = await measured(t, true);
  assert.equal(on.item, off.item);
  assert.equal(on.printed, off.printed);
});

test('clause 3: with next.oneGitRead off, next reads exactly as it does with the setting unset [C7,#9853]', async (t) => {
  const unset = await measured(t, undefined);
  const off = await measured(t, false);
  assert.equal(off.reads.length, unset.reads.length);
  assert.equal(off.item, unset.item);
  assert.equal(off.printed, unset.printed);
});
