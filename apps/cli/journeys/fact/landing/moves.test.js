/** @pullboard-test-input packages/landing/index.js */
/** A landing moves the trunk ref by compare-and-swap whatever the primary checkout holds, and refuses aloud when the ref moved [C7,P7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { moveTrunkRef } from '../../../../../packages/landing/index.js';
import { runLandingJob } from '../../../../../packages/landing/index.js';

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Run git in a directory and return trimmed stdout. */
function sh(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

test('clause 1: a land job moves the board host checkout\'s trunk ref to the landed tip with an untracked file there, which survives [C7,P7]', async () => {
  const dir = privateFixtureFiles('land-host-').root;
  scratch.push(dir);
  const host = join(dir, 'host');
  mkdirSync(host);
  sh(host, 'init', '-q', '-b', 'main');
  writeFileSync(join(host, 'README.md'), 'seed\n');
  sh(host, 'add', 'README.md');
  sh(host, 'commit', '-q', '-m', 'chore: seed');
  const base = sh(host, 'rev-parse', 'HEAD');
  sh(host, 'checkout', '-q', '-b', 'item/1');
  mkdirSync(join(host, 'web'));
  writeFileSync(join(host, 'web', 'land-1.test.js'), 'PASS\n');
  sh(host, 'add', 'web/land-1.test.js');
  sh(host, 'commit', '-q', '-m', 'feat(web): land one [C7]');
  const item = sh(host, 'rev-parse', 'HEAD');
  sh(host, 'checkout', '-q', 'main');
  mkdirSync(join(host, 'docs'), { recursive: true });
  writeFileSync(join(host, 'docs', 'stray-helper.sh'), 'echo stray\n');
  const payload = { remote: host, trunk: 'refs/heads/main', expect: base, checkout: true, items: [{ id: 1, commit: item, ref: 'refs/heads/item/1' }] };
  const receipt = await runLandingJob(payload, { workdir: join(dir, 'runner'), checks: () => ({ ok: true }) });
  assert.deepEqual([receipt.outcome, receipt.landed, receipt.base, receipt.moved], ['landed', [1], base, []], JSON.stringify(receipt));
  assert.equal(sh(host, 'rev-parse', 'main'), receipt.trunk, 'the trunk ref names the landed commit');
  assert.deepEqual(sh(host, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1), [base, item], 'main moved from its base to one merge of the item, never a fast-forward');
  assert.ok(existsSync(join(host, 'docs', 'stray-helper.sh')), 'the untracked file survives');
  assert.ok(existsSync(join(host, 'web', 'land-1.test.js')), 'the primary checkout holds the landed tracked file');
  assert.equal(sh(host, 'status', '--porcelain', '--untracked-files=no'), '', 'the checkout\'s tracked files match the landed tip');
});

test('clause 2: a trunk ref that moved before the finish records the batch blocked with LAND_MAIN_MOVED naming both commits and never says fast-forwarded [C7]', async () => {
  const dir = privateFixtureFiles('finish-moved-').root;
  scratch.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', 'a.txt');
  sh(dir, 'commit', '-q', '-m', 'base');
  const base = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', '-b', 'batch');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  sh(dir, 'add', 'b.txt');
  sh(dir, 'commit', '-q', '-m', 'batch tip');
  const tip = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  sh(dir, 'add', 'c.txt');
  sh(dir, 'commit', '-q', '-m', 'main moved');
  const moved = sh(dir, 'rev-parse', 'HEAD');
  const lines = [];
  const records = [];
  const state = {
    root: dir, batch: { id: 7, base, tip, revision: 3, state: 'trunk' }, board: { clock: { now: () => new Date(0) } },
    say: line => lines.push(line),
    write: async (operation, args) => { records.push({ operation, batch: args[0].batch }); return args[0].batch; },
  };
  await assert.rejects(() => moveTrunkRef(state), error => error.code === 'LAND_MAIN_MOVED' && [base, tip, moved].every(commit => error.message.includes(commit)));
  assert.equal(sh(dir, 'rev-parse', 'main'), moved, 'the ref stays where it was');
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, 'recordLandingBatch');
  assert.equal(records[0].batch.state, 'blocked');
  assert.equal(records[0].batch.refusal.code, 'LAND_MAIN_MOVED');
  assert.ok([base, tip, moved].every(commit => records[0].batch.refusal.message.includes(commit)));
  assert.ok(lines.some(line => line.includes('not moved') && line.includes(moved)), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('fast-forwarded')));
});
