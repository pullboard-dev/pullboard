/** With next.oneGitRead on, the git status, rev-parse and rev-list reads of next's selection each run once per command and next picks and prints what it does with the setting off [C7,#9853,#5329]. @pullboard-test-input source-cell apps/cli packages/store packages/config */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { largeBoard } from '../../tests/fixtures/board/large.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const READS = new Set(['status', 'rev-parse', 'rev-list']);

/** Write next.oneGitRead into the fixture machine's settings, or leave it unset when `value` is undefined. */
function setting(box, value) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let known = {};
  try { known = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fresh machine has no settings yet. */ }
  if (value !== undefined) known.next = { ...known.next, oneGitRead: value };
  writeFileSync(file, JSON.stringify(known));
}

const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/** Run `work` while every child process this process starts is noted; the three reads among the git children come back as `subcommand args`, git's -C path pair skipped. */
async function recordingReads(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  const reads = [];
  for (const api of APIS) {
    childProcess[api] = function recorded(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      const rest = Array.isArray(args[1]) ? args[1].map(String) : typeof args[0] === 'string' ? args[0].trim().split(/\s+/u).slice(1) : [];
      if (command.endsWith('git')) {
        const own = [...rest];
        while (own[0] === '-c' || own[0] === '-C') own.splice(0, 2);
        if (READS.has(own[0])) reads.push(own.join(' '));
      }
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try { await work(); } finally {
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
  return reads;
}

/** One `next --build` on a fresh large board with the setting at `value`: the item it handed out, what it printed and its git reads. */
async function measured(t, value) {
  const box = largeBoard(t, { scale: { items: 2_500, events: 5_000, shouts: 1_000, seats: 100 } });
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Git reads sample', diagnose: false, args: ['--specs', 'G1'] });
  setting(box, value);
  let result;
  const reads = await recordingReads(async () => { result = await box.runIn(box.web, 'next', '--build', '--json'); });
  assert.equal(result.code, 0, `next exited ${result.code}: ${result.err}${result.out}`);
  const answer = JSON.parse(result.out);
  const printed = (result.out + result.err).replaceAll(box.dir, '<box>').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/gu, '<time>').replace(/\b[0-9a-f]{40}\b/gu, '<sha>');
  return { item: answer?.item?.item_id ?? answer?.item_id, printed, reads };
}

test('clause 1: with next.oneGitRead on, next spawns fewer status, rev-parse and rev-list reads than with it off [C7,#9853]', async (t) => {
  const off = await measured(t, false);
  const on = await measured(t, true);
  console.log(`# next git reads off: ${off.reads.length}; on: ${on.reads.length}`);
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
