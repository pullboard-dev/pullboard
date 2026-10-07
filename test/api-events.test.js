/** CLI move events are the rows written by their command, even with another writer (A2, R2). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { main } from '../src/cli.js';
import * as store from '../src/board.js';

const sandboxes = [];

after(() => {
  for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true });
});

/** Make a real repo with isolated Git settings and a private Pullboard home. */
async function project(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-api-events-'));
  sandboxes.push(directory);
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const env = {
    PULLBOARD_HOME: join(directory, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'API Events Test',
    GIT_AUTHOR_EMAIL: 'api-events@example.invalid',
    GIT_COMMITTER_NAME: 'API Events Test',
    GIT_COMMITTER_EMAIL: 'api-events@example.invalid',
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  await command(repo, ['init', '--json']);
  const configFile = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({ ...config, lanes: { app: { owns: ['app/'], specs: [] } }, shared: [] }, null, 2)}\n`);
  return { directory, repo, env };
}

/** Invoke the imported CLI entry point with quiet streams and the fixture repo as its cwd. */
async function command(cwd, argv, streams = {}) {
  let stdout = '';
  let stderr = '';
  return {
    code: await main(argv, {
      cwd,
      stdout: { isTTY: false, write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
      ...streams,
    }),
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

test('[A2, R2] a command emits its inserted event when another connection writes during delivery', async (t) => {
  const { repo } = await project(t);
  let emitted;
  let laterEvent;
  const result = await command(repo, ['add', 'app', 'Original move', '--json'], {
    onEvent(event) {
      emitted = event;
      const other = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
      try {
        assert.equal(other.lastEvent, undefined, 'a new connection has no copy of another connection\'s last event');
        store.addItem(other, { by: 'coordinator', lane: 'app', title: 'Concurrent move' });
        laterEvent = other.lastEvent;
      } finally {
        store.closeBoard(other);
      }
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).item.item_title, 'Original move');
  assert.equal(emitted.event_kind, 'add');
  assert.equal(emitted.event_by, 'coordinator');
  assert.ok(laterEvent.event_id > emitted.event_id, 'the second connection appended a later event');
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const events = store.events(board);
    assert.equal(events.at(-2).event_id, emitted.event_id);
    assert.equal(events.at(-1).event_id, laterEvent.event_id);
    assert.notEqual(emitted.event_id, events.at(-1).event_id, 'delivery used this command\'s row, not the global newest row');
  } finally {
    store.closeBoard(board);
  }
});

test('[A2, R2] a refused command emits no move event', async (t) => {
  const { repo } = await project(t);
  const successful = await command(repo, ['add', 'app', 'Existing move', '--json']);
  assert.equal(successful.code, 0, successful.stderr);
  const before = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  let beforeCount;
  try { beforeCount = store.events(before).length; } finally { store.closeBoard(before); }

  let emitted = 0;
  const refused = await command(repo, ['add', 'missing', 'Refused move', '--json'], { onEvent() { emitted += 1; } });
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, 'NO_LANE');
  assert.equal(emitted, 0);
  const after = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { assert.equal(store.events(after).length, beforeCount); } finally { store.closeBoard(after); }
});


test('[A2, R2] rolling back a transaction also discards its captured events', async (t) => {
  const { repo } = await project(t);
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const item = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Committed move' });
    const rows = store.events(board);
    const emitted = [...board.emittedEvents];
    const last = board.lastEvent;
    assert.throws(() => store.atomic(board, () => {
      store.recordAttempt(board, item, { agentId: 'coordinator', n: 1, seconds: 1, result: 'rolled back' });
      throw new Error('abort the real SQLite transaction');
    }), /abort the real SQLite transaction/);
    assert.deepEqual(store.events(board), rows, 'the database contains only committed events');
    assert.deepEqual(board.emittedEvents, emitted, 'delivery cannot include rolled-back rows');
    assert.deepEqual(board.lastEvent, last, 'the retained row still belongs to a committed move');
    store.recordAttempt(board, item, { agentId: 'coordinator', n: 2, seconds: 1, result: 'committed' });
    assert.deepEqual(board.emittedEvents, [...emitted, board.lastEvent]);
    assert.equal(JSON.parse(board.lastEvent.event_detail).result, 'committed');
  } finally {
    store.closeBoard(board);
  }
});
