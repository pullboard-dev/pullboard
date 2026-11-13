/** Counter availability selects the real proof-statistics path without changing historical results [R1,R2,C7]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  addItem,
  closeBoard,
  register,
} from '../../../../packages/store/index.js';
import {
  openBoard,
  openBoardForRead,
} from '../../../lib/index.js';
import {
  clearProofCounters,
  currentProofCounters,
  proofCounter,
} from '../../../../packages/verify/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { proofStats as legacyProofStats } from '../../../lib/tests/fixtures/legacy.js';

/** Native read operations explicitly supplied to the statistics under test. */
const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };


/** Record actual prepared statements while preserving native SQLite receiver bindings. */
function recordingBoard(board, statements) {
  const db = new Proxy(board.db, {
    /** Observe SQL without changing its result, admission, or transaction behavior. */
    get(target, key) {
      if (key === 'prepare') return (sql) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...board, db };
}

/** Make a private on-disk board using native moves, then emulate an older writer or a missing local cache. */
function fixture(t, state) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-stats-cold-'));
  const file = join(directory, 'board.sqlite');
  const clock = { now: () => new Date('2026-10-01T00:00:00.000Z') };
  const board = openBoard(file, clock);
  try {
    register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
    const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'Historical proof', criterion: 'all events remain counted' });
    assert.ok(currentProofCounters(board), 'native moves built current counters');
    if (state === 'stale') {
      board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
        .run('2026-10-02T00:00:00.000Z', 'coordinator', 'submit', id, JSON.stringify({ commit: 'a'.repeat(40) }));
      assert.ok(proofCounter(board, 'summary'), 'stale is present, not absent');
      assert.equal(currentProofCounters(board), null, 'the real older-writer event makes the cursor stale');
    }
    if (state === 'absent') {
      clearProofCounters(board);
      assert.equal(proofCounter(board, 'summary'), null);
    }
  } finally { closeBoard(board); }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { file, clock };
}

for (const state of ['current', 'stale', 'absent']) {
  test(`proof stats ${state} counters preserve legacy results; writable open repairs cold state [R1,R2,C7]`, (t) => {
    const { file, clock } = fixture(t, state);
    const options = { now: Date.parse('2026-10-03T00:00:00.000Z') };
    let expected;
    const reader = openBoardForRead(file, clock);
    try {
      const statements = [];
      const notices = [];
      const changes = reader.db.prepare('SELECT total_changes() AS n').get().n;
      expected = legacyProofStats(reader, options);
      assert.deepEqual(proofStats(recordingBoard(reader, statements), { ...options, onFallback: () => notices.push('legacy') }, statsReadPorts), expected);
      assert.equal(notices.length, state === 'current' ? 0 : 1, 'only an actual legacy read announces fallback');
      assert.equal(statements.some(sql => /^SELECT \* FROM event ORDER BY event_id$/u.test(sql)), state !== 'current');
      assert.equal(reader.db.prepare('SELECT total_changes() AS n').get().n, changes, 'readonly statistics never warm the counters');
      assert.equal(currentProofCounters(reader) !== null, state === 'current', 'reading leaves the cache availability unchanged');
    } finally { closeBoard(reader); }

    // This is the real writable opener used by ordinary commands, not a manual cache repair.
    closeBoard(openBoard(file, clock));
    const warmed = openBoardForRead(file, clock);
    try {
      assert.ok(currentProofCounters(warmed), 'the next writable open automatically builds or catches up counters');
      const statements = [];
      let notices = 0;
      assert.deepEqual(proofStats(recordingBoard(warmed, statements), { ...options, onFallback: () => { notices += 1; } }, statsReadPorts), expected);
      assert.equal(notices, 0);
      assert.equal(statements.some(sql => /^SELECT \* FROM event ORDER BY event_id$/u.test(sql)), false, 'the repaired hot path never replays the whole event table');
    } finally { closeBoard(warmed); }
  });
}

/** Exercise the user-visible cold notice through the actual CLI in an isolated real Git repository. */
test('resume announces complete proof fallback in text and JSON until a native write repairs counters [N19,R1,R2,C7]', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-resume-cold-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const shims = join(directory, 'bin');
  mkdirSync(shims);
  const bin = resolve(import.meta.dirname, '../../pullboard.js');
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, PULLBOARD_VIEW_BACKGROUND: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  /** Run real Git using only the fixture identity and checkout. */
  const git = (...args) => runFixtureGit(args, { cwd: repo, env });
  /** Run the production CLI and preserve any actual setup failure. */
  const run = async (...args) => {
    const result = await runCliInProcess(args, { cwd: repo, env });
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
    return result.stdout;
  };
  git('init', '-q', '-b', 'main');
  await run('init');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }));
  writeFileSync(join(repo, 'SPEC.md'), '# Proof fixture\n\n## G · Goals\n- G1 [approved, must] Proof history stays complete. | gate: test\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: create cold resume fixture');
  await run('resume', '--json'); // Finish any first-resume native bookkeeping before making the cache cold.
  const file = join(git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file);
  try { clearProofCounters({ db }); } finally { db.close(); }
  const cold = JSON.parse(await run('resume', '--json'));
  assert.match(cold.proofStatsFallback, /counters are unavailable.*complete event history.*next writable command/iu);
  assert.ok(cold.flow, 'cold resume still returns its complete flow result');
  const text = await run('resume');
  assert.equal(text.split('\n').filter(line => line === cold.proofStatsFallback).length, 1, 'plain resume announces the actual fallback once');
  await run('shout', 'all', 'A normal native write builds the local counters.');
  const hot = JSON.parse(await run('resume', '--json'));
  assert.equal(Object.hasOwn(hot, 'proofStatsFallback'), false, 'the next native write ends the cold state');
  assert.ok(hot.flow);
});
