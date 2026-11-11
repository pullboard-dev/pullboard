/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js packages/store/index.js */
/** @pullboard-test-loads packages/store/src/io/board.js */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  join,
  resolve,
} from 'node:path';
import { writeFileSync } from 'node:fs';
import { exportBoard } from '../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../packages/link/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  runFixtureChildAsync,
  startFixtureChild,
} from '../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Snapshot the real private board without acquiring a write lock. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return exportBoard({ db }, { beginCommandPhase }); }
  finally { db.close(); }
}

/** Hold a named public store transaction until the parent releases it, as another seat's submit would. */
async function holdNamedWriter(box, file) {
  const releaseFile = join(box.dir, 'release-queue-board-writer');
  const source = `
    import * as store from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};
    import { openBoard } from ${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)};
    import { existsSync } from 'node:fs';
    const board = openBoard(process.argv[1], undefined, {
      writeContext: { command: 'private-lock-holder', seat: 'core-holder' },
    });
    try {
      store.atomic(board, () => {
        process.send({ kind: 'locked' });
        const deadline = Date.now() + 60_000; // budget: bound an owned fixture covering a wait past SQLite's 10 s timeout.
        while (!existsSync(process.argv[2])) {
          if (Date.now() >= deadline) throw new Error('private lock owner was not released');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      });
    } finally {
      store.closeBoard(board);
      if (process.connected) process.disconnect();
    }
  `;
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', source, file, releaseFile], {
    cwd: box.repo, env: box.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => resolveClosed({ code, signal })));
  let released = false;
  /** Release and drain only the private holder started above. */
  async function release() {
    if (!released) { released = true; writeFileSync(releaseFile, 'release\n'); }
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null }, stderr || child.fixtureFailure);
  }
  try {
    await new Promise((resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.once('close', (code, signal) => rejectReady(new Error(`private named writer exited before readiness: ${code}/${signal}`)));
      child.on('message', message => { if (message?.kind === 'locked') resolveReady(); });
    });
  } catch (error) {
    await release();
    throw error;
  }
  return { release };
}

test('two concurrent board writes queue past the busy timeout, print the wait and holder, and both complete [C7,P4,B2]', async (t) => {
  const box = e2e.project();
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const holder = await holdNamedWriter(box, file);
  t.after(holder.release);
  const env = { ...box.env, PULLBOARD_BOARD_QUEUE_MS: '40000' };
  const writers = ['one', 'two'].map(name => runFixtureChildAsync(process.execPath, [BIN, 'shout', 'all', `queued private shout ${name}`, '--json'], { cwd: box.repo, env }));
  // Hold past SQLite's own 10 s timeout, so both writers must retry rather than refuse; budget: the product's declared timeout plus margin.
  await new Promise(resolveDelay => setTimeout(resolveDelay, 12_500));
  await holder.release();
  const results = await Promise.all(writers);
  for (const result of results) {
    assert.equal(result.status, 0, result.context);
    assert.match(result.stderr, /pullboard: board write queued, still waiting for the lock/u, result.stderr);
    assert.match(result.stderr, /private-lock-holder/u, 'the printed wait names the holder command');
    assert.match(result.stderr, /core-holder/u, 'the printed wait names the holder seat');
    assert.doesNotMatch(result.stderr, /BOARD_BUSY/u, 'a queued write never reports the refusal');
  }
  assert.equal(snapshot(file).tables.shout.length, before.tables.shout.length + 2, 'each queued writer made exactly one shout');
});

test('a holder past the queue bound still fails with BOARD_BUSY naming it, changing nothing [C7,P4,B2]', async (t) => {
  const box = e2e.project();
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const holder = await holdNamedWriter(box, file);
  t.after(holder.release);
  const env = { ...box.env, PULLBOARD_BOARD_QUEUE_MS: '2000' };
  const refused = await runFixtureChildAsync(process.execPath, [BIN, 'shout', 'all', 'bounded private shout', '--json'], { cwd: box.repo, env });
  await holder.release();
  assert.equal(refused.status, 1, refused.context);
  const document = JSON.parse(refused.stdout);
  assert.equal(document.error.code, 'BOARD_BUSY');
  assert.match(document.error.message, /private-lock-holder/u);
  const waited = Number(/after (\d+)ms/u.exec(document.error.message)?.[1]);
  assert.ok(waited >= 12_000, `the refusal reports the whole queued wait, not the first timeout: ${waited}`); // budget: 10 s SQLite timeout plus the 2 s queue bound.
  assert.deepEqual(snapshot(file), before, 'a refused queued write changes no board table');
});
