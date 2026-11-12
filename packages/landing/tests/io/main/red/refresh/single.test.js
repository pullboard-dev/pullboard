/** @pullboard-test-input packages/landing/src/io/main/red/refresh.js */
/**
 * Main-red refresh runs one at a time and holds no checkout lease while its comparison runs [C7].
 * On 9 Nov twelve copies ran at once, one of them holding the main checkout's lease for 39+ minutes while board writes waited.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../../../apps/cli/tests/fixtures/child.js';
import { cellProject } from '../../../../../../store/tests/fixtures/cell.js';
import { repoInfo } from '../../../../../../git/index.js';
import { bindLocalSession } from '../../../../../../seats/index.js';
import { holdRefreshFlight } from '../../../../../src/io/main/red/refresh/flight.js';
import { refreshFlightFiles } from '../../../../../src/io/main/red/refresh/flight.js';
import { refreshMainRedComparisons } from '../../../../../src/io/main/red.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A private folder removed when the test ends. */
function folder(t, prefix) {
  const dir = privateFixtureFiles(prefix).root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Whether a promise settles within `ms`. */
async function settlesWithin(promise, ms) {
  let timer;
  const late = new Promise((done) => { timer = setTimeout(() => done('late'), ms); });
  try { return (await Promise.race([promise.then(() => 'settled'), late])) === 'settled'; } finally { clearTimeout(timer); }
}

test('a refresh launched while one runs gets no lock and leaves the one process holding it [C7]', async (t) => {
  const dir = folder(t, 'pullboard-refresh-single-');
  const files = refreshFlightFiles(join(dir, 'machine-home'));
  const letGo = holdRefreshFlight(files);
  t.after(() => letGo?.());
  assert.equal(typeof letGo, 'function', 'the first refresh takes the lock');
  const holder = readFileSync(files.lock, 'utf8');
  const extra = [holdRefreshFlight(files), holdRefreshFlight(files), holdRefreshFlight(files)];
  assert.deepEqual(extra.map(Boolean), [false, false, false], 'each extra refresh is refused at once, so it exits');
  assert.equal(readFileSync(files.lock, 'utf8'), holder, 'the running refresh still holds the lock, and no other process took it');
});

test('a running refresh comparison holds no checkout lease, so a board write in that checkout finishes in under 1 s [C7]', async (t) => {
  const box = cellProject(t);
  const saved = { ...process.env };
  Object.assign(process.env, { PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME, PULLBOARD_HOME: box.env.PULLBOARD_HOME });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  mkdirSync(join(box.repo, '.git', 'pullboard'), { recursive: true });
  writeFileSync(join(box.repo, '.git', 'pullboard', 'main-red.json'), JSON.stringify({ version: 2, entries: {
    [SHA_A]: { 'test/slow.test.js': { result: 'red', failures: [] } },
  } }), { mode: 0o600 });
  let started;
  const comparing = new Promise(done => { started = done; });
  let finish;
  const hold = new Promise(done => { finish = done; });
  const refresh = refreshMainRedComparisons(box.repo, SHA_A, SHA_B, () => {}, async () => {
    started();
    await hold;
    return { main: SHA_B, files: [] };
  });
  await comparing;
  const digest = createHash('sha256').update('refresh-lease-writer').digest('hex');
  const write = bindLocalSession(repoInfo(box.repo), { agent: 'writer', digest });
  const settled = await settlesWithin(write, 1000); // budget: declared ceiling, the 1 s board-write target.
  finish();
  await refresh;
  assert.equal(settled, true, 'a board write finishes within a second while the comparison runs');
  assert.equal(await write, undefined, 'a write that keeps no lease binds and lets go');
});
