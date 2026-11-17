/** A seat whose worktree is behind main is told once per command, in one line [N2,B3]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Run the real command parser in plain text mode, since the lag line is a text line that --json mode does not print. */
async function cli(box, cwd, args) {
  let out = '', err = '';
  const code = await main(args, { cwd, clock: box.clock, stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  return { code, out, err };
}

/** Land `count` commits on the fixture's main, so a seat checkout cut earlier falls behind. */
function landOnMain(box, count) {
  for (let n = 1; n <= count; n += 1) {
    writeFileSync(join(box.root, `web/landed-${n}.txt`), `landed ${n}\n`);
    box.git(box.root, 'add', `web/landed-${n}.txt`);
    box.git(box.root, 'commit', '-q', '-m', `chore(web): landing ${n} [G1]`);
  }
}

test('clause 1: next, claim and inbox print one line naming the commits behind and the base age when the seat is behind main [N2,B3]', async t => {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  const id = box.add('Work a lagging seat claims');
  const seat = box.seats.actor.path;

  landOnMain(box, 3);
  const lag = /this checkout is 3 commits behind main, its base is \d+ (min|h|days) old/u;
  for (const args of [['inbox'], ['next', '--take'], ['claim', String(id)]]) {
    const result = await cli(box, seat, args);
    const text = result.out + result.err;
    assert.match(text, lag, `${args[0]} names the lag: ${text}`);
    assert.equal(text.match(/commits behind/gu).length, 1, `${args[0]} prints the lag once`);
  }
});

test('clause 2: a seat level with main prints no lag line [N2,B3]', async t => {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  box.add('Work a level seat claims');
  const seat = box.seats.actor.path;
  for (const args of [['inbox'], ['next', '--take']]) {
    const level = await cli(box, seat, args);
    assert.equal(level.code, 0, level.out + level.err);
    assert.doesNotMatch(level.out + level.err, /behind/u, `${args[0]} on a level seat prints no lag line`);
  }
});
