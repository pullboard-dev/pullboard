/**
 * Repro, 9 Nov about 1:25 am CT: the coordinator's `hold --off`, `add` and `edit` queued over ten minutes, because
 * every write held its checkout's lease for its whole run and a `merged` that ran tests held it first. The invariant:
 * a board write in the coordinator's checkout answers, and holds the board's write lock under 1 s, while a slow
 * same-session command runs, a reader keeps one read transaction open, a gate worker keeps writing and dead writers
 * left their records beside the board [C7]. Fails on 58f204a4af^ (the add never answers while the slow command runs).
 *
 * Everything runs on a scratch project in its own processes: real Git, the real CLI and a real SQLite board.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ROOT,
  from,
  guardProcesses,
  hopCheck,
  track,
  within,
} from '../kit.js';

const { createE2eHelpers } = await from('apps/cli/tests/fixtures/e2e.js');

/** The board-write target: any write holds the lock, and lands, in under 1 s. */
const WRITE_TARGET_MS = 1_000;
/** How long the add may take before the hop counts it as queued; a fresh CLI process starts in seconds under load. */
const ANSWER_LIMIT_MS = 60_000;

const helpers = createE2eHelpers();
const children = [];
guardProcesses({ before: async () => {
  for (const child of children) child.stdin?.end();
  await Promise.all(children.map(child => child.closed));
  helpers.cleanup();
} });

/** Start a process running `source` with `args`, resolved once it prints ready. */
function start(source, args, env) {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.closed = new Promise(done => child.once('close', done));
  child.ready = new Promise((done, fail) => {
    child.stdout.setEncoding('utf8').on('data', text => { output += text; if (output.includes('ready')) done(); });
    child.stderr.setEncoding('utf8').on('data', text => { output += text; });
    child.once('close', code => fail(new Error(`helper exited ${code} before it was ready: ${output.slice(0, 400)}`)));
  });
  children.push(child);
  return child;
}

/** Run one CLI command in its own process, resolving with its result and wall time, or `late` past the limit. */
function cli(box, cwd, args) {
  const started = performance.now();
  const child = spawn(process.execPath, [join(ROOT, 'apps/cli/pullboard.js'), ...args], { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', text => { out += text; });
  child.stderr.setEncoding('utf8').on('data', text => { err += text; });
  return new Promise(done => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); done({ late: true, ms: performance.now() - started, out, err }); }, ANSWER_LIMIT_MS);
    child.once('close', code => { clearTimeout(timer); done({ code, ms: performance.now() - started, out, err }); });
  });
}

test('a coordinator write answers past a slow same-session command, a long reader, a gate worker and dead holders [C7]', { timeout: 300_000 }, async () => {
  const box = helpers.project(undefined, undefined, { withWorktree: false });
  track(box.dir);
  box.env.CODEX_SESSION_ID = 'hop-board-write';
  const board = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const first = await cli(box, box.repo, ['add', 'web', 'Bind the coordinator checkout', '--specs', 'G1']);
  if (first.code !== 0) throw new Error(`the first add failed: ${first.err.slice(0, 400)}`);

  // Dead writers' records, as found beside the real board on 9 Nov.
  const holders = board + '.write-holders';
  mkdirSync(holders, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(holders, `${900_000 + index}-0000000${index % 10}-0000-4000-8000-000000000000.json`), JSON.stringify({ version: 1, pid: 900_000 + index,
      started: 'Mon Oct 26 14:56:00 2026', processSha256: 'a'.repeat(64), command: 'shout', seat: 'core-699', acquiredAt: Date.now() - 86_400_000, contender: true }) + '\n');
  }
  const url = path => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
  // A slow same-session command in the coordinator's checkout, like a `merged` running tests.
  const slow = start(`
    import { bindLocalSession } from ${url('packages/seats/src/io/agent/session.js')};
    import { agentSessionDigest } from ${url('packages/person/index.js')};
    import { repoInfo } from ${url('packages/git/index.js')};
    const held = await bindLocalSession(repoInfo(process.argv[1]), { agent: 'coordinator', digest: agentSessionDigest(), keepLease: true });
    process.stdout.write('ready\\n');
    process.stdin.on('end', () => { held.release(); process.exit(0); }).resume();`, [box.repo], { ...box.env });
  // A reader holding one read transaction open, like a long state build.
  const reader = start(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM event').get();
    process.stdout.write('ready\\n');
    process.stdin.on('end', () => { db.exec('COMMIT'); db.close(); process.exit(0); }).resume();`, [board], box.env);
  // A gate worker writing short transactions back to back, like recordGateRun.
  const worker = start(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout = 10000');
    let stop = false, beats = 0;
    process.stdin.on('end', () => { stop = true; }).resume();
    const beat = () => {
      if (stop) { db.close(); process.exit(0); }
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO board_meta(meta_key, meta_value) VALUES ('local:hop-gate-worker', ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value").run(String(++beats));
      db.exec('COMMIT');
      if (beats === 3) process.stdout.write('ready\\n');
      setTimeout(beat, 5);
    };
    beat();`, [board], box.env);
  await Promise.all([slow.ready, reader.ready, worker.ready]);

  await hopCheck('board-write', async () => {
    const writes = join(box.env.PULLBOARD_MACHINE_HOME, 'board-writes.jsonl');
    const before = existsSync(writes) ? readFileSync(writes, 'utf8').length : 0;
    const added = await cli(box, box.repo, ['add', 'web', 'Lands while the slow command runs', '--specs', 'G1']);
    const held = (existsSync(writes) ? readFileSync(writes, 'utf8').slice(before) : '').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.command === 'add');
    const holdMs = held.length ? Math.max(...held.map(row => row.durationMs)) : null;
    const measured = { ms: added.ms, measured: added.late ? `add still queued after ${Math.round(added.ms / 1000)} s`
      : `add answered in ${Math.round(added.ms)} ms; its writes held the lock at most ${holdMs ?? '?'} ms` };
    within(!added.late && added.code === 0, `the add answers while the slow command runs: ${added.err.slice(0, 200)}`, measured);
    within(holdMs !== null && holdMs < WRITE_TARGET_MS, `every write of the add holds the lock under ${WRITE_TARGET_MS} ms`, measured);
    return measured;
  });
  for (const child of children) child.stdin.end();
  await Promise.all(children.map(child => child.closed));
});
