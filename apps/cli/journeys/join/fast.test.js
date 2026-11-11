import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { ensureProofCounters } from '../../../../packages/verify/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fixtureJoinArgv } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Run a command in a real fixture process and retain useful failure output. */
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout);
  return result;
}

/** Make a large persistent board before timing the fresh worktree join. */
function largeBoard(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-join-fast-')));
  const env = { ...process.env, PULLBOARD_HOME: join(root, 'home'), PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Join fixture',
    GIT_AUTHOR_EMAIL: 'join@example.invalid', GIT_COMMITTER_NAME: 'Join fixture', GIT_COMMITTER_EMAIL: 'join@example.invalid' };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', spec: 'SPEC.md',
    // The model table determines the route since b95e1aa538.
    modelTiers: [{ contains: 'fixture-model', route: 'strong' }],
    lanes: { core: { owns: ['src/'], specs: ['H24'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Join fixture\n\n## H · Human time\n- H24 [approved, aim] Joins are fast. | gate: apps/cli/journeys/join/fast.test.js\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/seed.js'), 'export const seed = true;\n');
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'Seed join fixture'], { cwd: root, env });
  const file = join(root, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file persistence: join warms and reopens one real board file, the path the claim measures.
  const board = openBoard(file);
  store.register(board, { lane: 'coordinator', path: root });
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Join claim fixture', criterion: 'A joined seat can claim this item.', specIds: ['H24'], check: 'true' });
  store.closeBoard(board);
  const db = new DatabaseSync(file);
  db.exec('BEGIN');
  const at = '2026-11-01T00:00:00.000Z';
  const agent = db.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_created_at) VALUES (?, ?, ?, ?)');
  for (let n = 1; n <= 800; n++) agent.run(`core-${n}`, 'core', join(root, 'seats', String(n)), at);
  const item = db.prepare(`INSERT INTO item (item_lane, item_title, item_criterion, item_status,
    item_created_by, item_created_at, item_updated_at) VALUES ('core', ?, 'Historical item.', 'open', 'coordinator', ?, ?)`);
  for (let n = 2; n <= 1000; n++) item.run(`Historical ${n}`, at, at);
  const event = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (let n = 0; n < 45_000; n++) event.run(at, `core-${1 + n % 800}`, n % 2 ? 'claim' : 'edit', 1 + n % 1000, '{}');
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < 23_000; n++) shout.run(`core-${1 + n % 800}`, 'all', `Historical activity ${n}`, at);
  db.exec('COMMIT');
  db.close();
  // @pullboard-board-file persistence: join warms and reopens one real board file, the path the claim measures.
  const warmed = openBoard(file);
  try { ensureProofCounters(warmed); } finally { store.closeBoard(warmed); }
  return { root, env };
}

/** Prove the published join budget on a board with current production-sized history [H24]. */
test('a fresh worktree joins a board at current scale in under two seconds and can claim immediately [H24]', async (t) => {
  const { root, env } = largeBoard(t);
  const worktree = join(root, 'fresh-worker');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/fresh-worker', worktree, 'HEAD'], { cwd: root, env });
  const started = performance.now();
  const joined = run(process.execPath, [...fixtureJoinArgv(BIN), 'core', '--model', 'fixture-model'], worktree, env);
  const elapsedMs = performance.now() - started;
  assert.match(joined.stdout, /joined as/u);
  assert.ok(elapsedMs < 1_800, `join took ${elapsedMs.toFixed(0)} ms on 1,000 items, 45,000 events and 23,000 shouts`); // budget: H24's 2 s ceiling gets 200 ms measurement margin.
  const claimed = run(process.execPath, [BIN, 'claim', '1'], worktree, env);
  assert.match(claimed.stdout, /claimed #1/u);
});

test('a seat on a light model joins the light route, and an explicit --route still wins [C7]', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-join-route-')));
  const env = { ...process.env, PULLBOARD_HOME: join(root, 'home'), PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Join fixture',
    GIT_AUTHOR_EMAIL: 'join@example.invalid', GIT_COMMITTER_NAME: 'Join fixture', GIT_COMMITTER_EMAIL: 'join@example.invalid' };
  delete env.PULLBOARD_ROUTE;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', spec: 'SPEC.md', lanes: { core: { owns: ['src/'], specs: ['H24'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Join fixture\n\n## H · Human time\n- H24 [approved, aim] Joins are fast. | gate: apps/cli/journeys/join/fast.test.js\n');
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'Seed join fixture'], { cwd: root, env });
  run(process.execPath, [BIN, 'init'], root, env);
  const joinAs = (name, args) => {
    const dir = join(root, '..', `${root.split('/').pop()}-${name}`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    runFixtureGit(['worktree', 'add', '-q', '-b', `core/${name}`, dir], { cwd: root, env });
    const result = run(process.execPath, [...fixtureJoinArgv(BIN), 'core', ...args], dir, env);
    return result.stdout;
  };
  assert.match(joinAs('haiku', ['--model', 'claude-haiku-4-5']), /on the light route/u);
  assert.match(joinAs('luna', ['--model', 'gpt-6-luna']), /on the light route/u);
  assert.doesNotMatch(joinAs('strong', ['--model', 'gpt-6-luna', '--route', 'strong']), /light route/u);
});
