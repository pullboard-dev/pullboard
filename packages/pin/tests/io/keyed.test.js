/** A killed writer's temporary file in a keyed-result folder is removed on the next write [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../git/tests/fixtures/child.js';
import { saveKeyedResult } from '../../index.js';
import { keyedResultPath } from '../../index.js';
import { captureKeyedFolder } from '../../index.js';
import { publishKeyedResult } from '../../index.js';
import { loadKeyedResult } from '../../index.js';

test('pin.keyed.dead-partial-removed: clause 1: a state-cache partial whose writer pid is dead is removed on the next write, and a live writer\'s partial stays [C7]', () => {
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

test('pin.keyed.publish-original-directory: clause 1: publishing writes complete bytes into the original existing directory and loads back, and a removed directory stays absent [C7]', () => {
  const folder = join(privateFixtureFiles('keyed-publish-').root, 'results');
  mkdirSync(folder);
  const captured = captureKeyedFolder(folder);
  assert.deepEqual(publishKeyedResult(captured, 'key', Buffer.from('complete bytes')), { ok: true });
  assert.equal(loadKeyedResult(folder, 'key').toString('utf8'), 'complete bytes');
  assert.deepEqual(readdirSync(folder), [basename(keyedResultPath(folder, 'key'))], 'no partial file is left');
  rmSync(folder, { recursive: true });
  const outcome = publishKeyedResult(captured, 'key', Buffer.from('late'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.unavailable, true);
  assert.equal(existsSync(folder), false, 'the removed directory is not recreated');
  assert.equal(captureKeyedFolder(folder), null);
});

test('pin.keyed.publish-refuses-replacement: clause 2: a replacement directory stays untouched and publication is explicitly unavailable, while saveKeyedResult still creates its folder [C7]', () => {
  const root = privateFixtureFiles('keyed-replace-').root;
  const folder = join(root, 'results');
  mkdirSync(folder);
  const captured = captureKeyedFolder(folder);
  const original = join(root, 'moved');
  renameSync(folder, original);
  mkdirSync(folder);
  const before = statSync(folder);
  const outcome = publishKeyedResult(captured, 'key', Buffer.from('bytes'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.unavailable, true);
  assert.deepEqual(readdirSync(folder), [], 'the replacement holds no file');
  assert.equal(statSync(folder).mtimeMs, before.mtimeMs, 'the replacement is untouched');
  assert.deepEqual(readdirSync(original), [], 'the moved original is not written either');
  assert.deepEqual(readdirSync(root).sort(), ['moved', 'results'], 'no staged file is left beside the directories');
  assert.equal(publishKeyedResult(null, 'key', Buffer.from('x')).unavailable, true);
  const fresh = join(root, 'fresh', 'deep');
  saveKeyedResult(fresh, 'key', Buffer.from('made'));
  assert.equal(loadKeyedResult(fresh, 'key').toString('utf8'), 'made', 'ordinary saves still create the folder');
});
