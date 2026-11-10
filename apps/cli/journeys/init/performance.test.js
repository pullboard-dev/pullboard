/** Real in-process CLI reads on a private board at the measured production scale [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
  loadavg,
  cpus,
} from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

/** Capture one complete production command, including its JSON serialization and fresh Git scope. */
async function command(root, argv) {
  let stdout = '', stderr = '';
  const started = performance.now();
  const code = await main([...argv, '--json'], { cwd: root,
    stdout: { isTTY: false, write(text) { stdout += text; } },
    stderr: { write(text) { stderr += text; } } });
  const ms = performance.now() - started;
  assert.equal(code, 0, stderr || stdout);
  return { ms, data: JSON.parse(stdout), stderr };
}

/** Seed real rows, not cached command results, with many historical submissions and a small live queue. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cli-read-performance-')));
  let db;
  t.after(() => { db?.close(); rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Performance fixture', GIT_AUTHOR_EMAIL: 'perf@example.invalid',
    GIT_COMMITTER_NAME: 'Performance fixture', GIT_COMMITTER_EMAIL: 'perf@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', submitGate: 'landing',
    lanes: { core: { owns: ['src/'], specs: ['C7'] } }, spec: 'SPEC.md' }));
  writeFileSync(join(root, 'SPEC.md'), '# Performance fixture\n## C\n- C7 [approved, must] Reads preserve the board. | gate: test\n');
  writeFileSync(join(root, 'PRACTICE.md'), '');
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'Seed performance fixture'], { cwd: root, env });
  const file = join(root, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(file);
  store.register(board, { lane: 'coordinator', path: root });
  store.closeBoard(board);
  db = new DatabaseSync(file);
  const at = '2026-10-23T00:00:00.000Z';
  db.exec('BEGIN');
  const agent = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 1; n <= 800; n++) agent.run(`core-${n}`, 'core', join(root, 'seats', String(n)), at);
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES ('core', ?, 'The read preserves evidence.', ?, 'coordinator', ?, ?)`);
  for (let n = 1; n <= 1000; n++) item.run(`Item ${n}`, 'open', at, at);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const commit = 'a'.repeat(40);
  const proof = JSON.stringify({ commit, submissionProof: { version: 1, files: ['test/a.test.js'], full: false, deferred: false, reason: 'affected selection' } });
  for (let n = 0; n < 45000; n++) event.run(at, `core-${1 + n % 800}`, n % 3 === 0 ? 'submit' : n % 3 === 1 ? 'claim' : 'edit', 1 + n % 1000, n % 3 === 0 ? proof : '{}');
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < 23000; n++) shout.run(`core-${1 + n % 800}`, 'all', `Board activity ${n}`, at);
  db.exec('COMMIT');
  const live = openBoard(file);
  try {
    for (let id = 1; id <= 10; id++) {
      store.claim(live, id, { agentId: `core-${id}`, lane: 'core', leaseMs: 3_600_000,
        freeze: () => ({ text: JSON.stringify({ rows: [] }), digest: 'performance-fixture' }) });
      submitFixture(live, id, { agentId: `core-${id}`, commit, tree: 'b'.repeat(40) });
    }
  } finally { store.closeBoard(live); }
  return { root, db };
}

/** Hash every persistent table outside the timed region, so a read cannot silently change board state. */
function boardDigest(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const rows = tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

test('status show and list each have a five-run in-process median under 100 ms on our board size [C7]', async t => {
  const { root, db } = fixture(t);
  const before = boardDigest(db);
  const events = db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const samples = { status: [], show: [], list: [] };
  for (let round = 0; round < 5; round++) {
    for (const name of Object.keys(samples)) {
      const result = await command(root, name === 'show' ? ['show', '1'] : [name]);
      samples[name].push(result.ms);
      if (name === 'status') {
        assert.equal(result.data.stats.items.submitted, 10);
        assert.equal(result.data.stats.items.open, 990);
        assert.equal(result.data.reviewQueue.pending, 10);
        assert.deepEqual(result.data.submitInvariantProposals, [], 'no failing landing evidence means no proposal');
      }
      if (name === 'show') {
        assert.equal(result.data.item_id, 1);
        assert.equal(result.data.item_status, 'submitted');
        assert.ok(result.data.thread.some(entry => entry.kind === 'submit'), 'detail retains submission history');
      }
      if (name === 'list') {
        assert.equal(result.data.items.length, 1000);
        assert.equal(new Set(result.data.items.map(item => item.item_id)).size, 1000);
        assert.equal(result.data.items.filter(item => item.item_status === 'submitted').length, 10);
        assert.equal(result.data.items[0].item_id, 1000, 'list remains newest first');
      }
    }
  }
  assert.equal(boardDigest(db), before, 'reads change no persistent board rows');
  const medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, [...values].sort((a, b) => a - b)[2]]));
  t.diagnostic(JSON.stringify({ samplesMs: samples, mediansMs: medians, node: process.version, cpus: cpus().length, load: loadavg(), items: 1000, events, shouts: 23000 }));
  for (const [name, median] of Object.entries(medians)) assert.ok(median < 100, `${name} median ${median.toFixed(2)} ms exceeds the declared 100 ms budget`);
});
