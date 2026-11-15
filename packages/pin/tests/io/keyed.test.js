/** A killed writer's temporary file in a keyed-result folder is removed on the next write [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { saveKeyedResult } from '../../index.js';
import { keyedResultPath } from '../../index.js';

test('clause 1: a state-cache partial whose writer pid is dead is removed on the next write, and a live writer\'s partial stays [C7]', () => {
  const folder = privateFixtureFiles('keyed-partial-').root;
  let deadPid = 4_000_000;
  /** Whether a pid is free: signalling it finds no process. */
  const free = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  while (!free(deadPid)) deadPid -= 1;
  const dead = join(folder, `abc.result.${deadPid}.partial`);
  const alive = join(folder, `abc.result.${process.ppid}.partial`);
  writeFileSync(dead, 'half');
  writeFileSync(alive, 'half');
  saveKeyedResult(folder, 'key', Buffer.from('whole'));
  assert.equal(existsSync(dead), false, 'the dead writer\'s partial is gone');
  assert.equal(existsSync(alive), true, 'a live writer\'s partial stays');
  assert.equal(readFileSync(keyedResultPath(folder, 'key'), 'utf8'), 'whole');
});
