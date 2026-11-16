/** No tracked file under packages/landing names this machine's old machine host; fixtures and comments use a neutral host name [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Built from parts so this file does not itself contain the word it forbids.
const WORD = ['van', 'illa'].join('');

test('clause 1: no tracked file under packages/landing contains the old machine host name [C7]', () => {
  const root = new URL('../../..', import.meta.url).pathname;
  const files = execFileSync('git', ['ls-files', '-z', 'packages/landing'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'git lists the tracked files');
  const hits = files.filter(file => readFileSync(`${root}/${file}`, 'utf8').toLowerCase().includes(WORD));
  assert.deepEqual(hits, [], 'use a neutral host name such as studio-host');
});

test('clause 2: the step failures module whose comment was reworded still loads [C7]', async () => {
  const mod = await import('../src/io/step/failures.js');
  assert.ok(Object.keys(mod).length > 0, 'failures.js exports are intact');
});
