/** A restarted pull runner removes the slot folders of its earlier instances and keeps its own [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../index.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const HOUR = 3_600_000;

/** Make the slot folders a serve with this runner id leaves in the cache: a checkout and its work folder per slot, aged as given. */
function leaveSlots(cache, id, slots, ageMs) {
  const paths = [];
  for (const slot of slots) {
    for (const parent of ['main', 'work']) {
      const path = join(cache, parent, `runner-${id}-${slot}`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'tracked.txt'), 'x');
      const at = new Date(Date.now() - ageMs);
      utimesSync(join(path, 'tracked.txt'), at, at); utimesSync(path, at, at);
      paths.push(path);
    }
  }
  return paths;
}

/** Start a serve with this runner id against a board with no jobs, and let it stop at its first idle wait. */
async function serveOnce(cache, id) {
  const stop = new AbortController();
  const fetchImpl = async () => ({ status: 200, json: async () => ({ trunk: 'x', claim: null }) });
  await serveRunner({ board: BOARD, runner: id, capabilities: [], cache, jobs: 2, signal: stop.signal, fetchImpl, sleep: async () => { stop.abort(); }, timing: { idleMs: 1 } });
}

test('restarting serve twice leaves only the current instance slots [P7]', async t => {
  const { root: cache } = privateFixtureFiles('pullboard-slots-cache-');
  t.after(() => { rmSync(cache, { recursive: true, force: true }); });
  const first = leaveSlots(cache, 'one', [0, 1], 48 * HOUR);
  await serveOnce(cache, 'two');
  assert.ok(first.every(path => !existsSync(path)), 'the first instance slots are gone after the second serve starts');
  const second = leaveSlots(cache, 'two', [0, 1], 24 * HOUR);
  const third = leaveSlots(cache, 'three', [0, 1], 24 * HOUR);
  await serveOnce(cache, 'three');
  assert.ok(second.every(path => !existsSync(path)), 'the second instance slots are gone after the third serve starts');
  assert.ok(third.every(path => existsSync(path)), 'the current instance slots stay');
});

test('a slot another serve changed within the grace stays [P7]', async t => {
  const { root: cache } = privateFixtureFiles('pullboard-slots-live-');
  t.after(() => { rmSync(cache, { recursive: true, force: true }); });
  const busy = leaveSlots(cache, 'busy', [0], 1000);
  await serveOnce(cache, 'mine');
  assert.ok(busy.every(path => existsSync(path)), 'a recently changed slot may hold a live job');
});
