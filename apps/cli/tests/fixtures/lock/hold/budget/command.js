/** @pullboard-module-loads apps/cli/pullboard.js apps/cli/tests/fixtures/lock/hold/budget/preload.js */
/** Actual private CLI lifecycle and authenticated HTTP reads, with all writer intervals retained [B2,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cpus } from 'node:os';
import { loadavg } from 'node:os';
import { freemem } from 'node:os';
import { createE2eHelpers } from '../../../e2e.js';
import { settleSubmit } from '../../../submit/settle.js';
import { runFixtureChild } from '../../../child.js';
import { fixtureJoin } from '../../../testkit.js';

/** Timings include the observer's begin-record append while held: conservative instrumented bounds. */
const N = 3;
const PRELOAD = fileURLToPath(new URL('./preload.js', import.meta.url));

/** Seed only private historical rows, never a live board or fabricated correctness receipt. */
function seed(box) {
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    db.exec('BEGIN');
    const at = '2026-10-23T00:00:00.000Z';
    const agent = db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_created_at) VALUES(?,?,?,?)');
    for (let n = 1; n <= 800; n++) agent.run(`budget-seat-${n}`, 'web', join(box.dir, 'seats', String(n)), at);
    const item = db.prepare("INSERT INTO item(item_lane,item_title,item_criterion,item_status,item_created_by,item_created_at,item_updated_at) VALUES('web',?,'Seeded history','open','coordinator',?,?)");
    for (let n = 1; n <= 1000; n++) item.run(`Seed item ${n}`, at, at);
    const event = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)');
    for (let n = 0; n < 45000; n++) event.run(at, `budget-seat-${1 + n % 800}`, 'edit', 1 + n % 1000, '{}');
    const shout = db.prepare('INSERT INTO shout(shout_from,shout_to,shout_text,shout_at) VALUES(?,?,?,?)');
    for (let n = 0; n < 23000; n++) shout.run(`budget-seat-${1 + n % 800}`, 'all', `Seed activity ${n}`, at);
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Observe the actual selected CLI only; explicit --import never leaks through NODE_OPTIONS. */
function command(box, bin, cwd, label, ...args) {
  const env = { ...box.env, PULLBOARD_LOCK_BUDGET_COMMAND: label };
  const result = runFixtureChild(process.execPath, ['--import', PRELOAD, bin, ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /LOCK_BUDGET_OBSERVER_UNAVAILABLE/u);
  return result.stdout;
}

/** Parse only files this private fixture owns; missing or malformed records fail rather than crediting a sample. */
function trace(file) {
  assert.ok(existsSync(file), 'the actual child observer retained its trace');
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Every acquired writer must have an explicit native release, even when it belongs to another captured database. */
function complete(rows) {
  const begins = rows.filter(row => row.kind === 'begin');
  const holds = rows.filter(row => row.kind === 'hold');
  assert.equal(rows.filter(row => row.kind === 'incomplete').length, 0);
  assert.equal(holds.length, begins.length, 'no acquired writer disappears from accounting');
  assert.deepEqual(holds.map(row => `${row.pid}:${row.id}`).sort(), begins.map(row => `${row.pid}:${row.id}`).sort());
  return holds;
}

/** Exercise the literal per-command and API-read acceptance bar on three independently seeded real projects. */
export async function assertCommandHoldBudget(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const samples = { claim: [], release: [], submit: [], verify: [] };
  for (let cycle = 0; cycle < N; cycle++) {
    const box = e2e.project('test ! -f RED', e2e.sandbox(), { withWorktree: false });
    box.web = join(box.dir, 'web-1');
    box.git(box.repo, 'worktree', 'add', '-q', box.web, '-b', 'web/one');
    const joined = fixtureJoin(box.run, box.web, 'web', '--model', 'gpt-6.1-sol', '--family', 'openai', '--route', 'strong');
    assert.equal(joined.code, 0, joined.err || joined.out);
    seed(box);
    const file = join(box.dir, 'lock-budget.jsonl');
    box.env.PULLBOARD_LOCK_BUDGET_TRACE = file;
    box.env.PULLBOARD_LOCK_BUDGET_ENTRY = e2e.BIN;
    try {
    const added = command(box, e2e.BIN, box.repo, 'setup', 'add', 'web', `Budget lifecycle ${cycle}`, '--specs', 'G1',
      '--criterion', 'The private fixture source exists', '--check', 'test -f web/hold-budget.js', '--json');
    const id = String(JSON.parse(added).item.item_id);
    command(box, e2e.BIN, box.web, 'claim', 'claim', id);
    command(box, e2e.BIN, box.web, 'release', 'release', id, '--reason', 'BLOCKED', '--no-next');
    command(box, e2e.BIN, box.web, 'reclaim', 'claim', id);
    mkdirSync(join(box.web, 'web'), { recursive: true });
    writeFileSync(join(box.web, 'web/hold-budget.js'), 'export const budget = true;\n');
    box.git(box.web, 'add', '-A');
    box.git(box.web, 'commit', '-q', '-m', 'feat(web): fixture source for hold budget [G1]');
    const commit = box.git(box.web, 'rev-parse', 'HEAD');
    // Under pull dispatch submit returns before its gate settles (e8f5582942): wait on the runner's receipt so verify sees a submitted item.
    const queued = JSON.parse(command(box, e2e.BIN, box.web, 'submit', 'submit', id, '--no-next', '--json'));
    await settleSubmit(t, { repo: box.web, env: box.env, run: box.run }, queued, { deadlineMs: 120_000 });
    box.git(box.repo, 'switch', '-q', '--detach', commit);
    try {
      command(box, e2e.BIN, box.repo, 'verify', 'verify', id, 'accept', '--as', 'coordinator', '--no-next', '--note', 'Private timing fixture only');
    } finally { box.git(box.repo, 'switch', '-q', 'main'); }
    box.env.PULLBOARD_LOCK_BUDGET_COMMAND = 'api';
    const view = await e2e.startView(box, box.repo, { nodeArgs: ['--import', PRELOAD] });
    const windows = [];
    try {
      for (let sample = 0; sample < 3; sample++) {
        const acquired = trace(file).filter(row => row.command === 'api' && row.kind === 'begin' && row.writeLockEvidence).length;
        const start = Date.now();
        const state = await view.state(box.repo);
        assert.ok(state.project, 'the real authenticated API served the seeded board');
        const end = Date.now();
        const after = trace(file);
        assert.equal(after.filter(row => row.command === 'api' && row.kind === 'begin' && row.writeLockEvidence).length, acquired, 'an API read starts no writer on any observed database');
        assert.equal(after.filter(row => row.command === 'api' && row.kind === 'hold' && row.writeLockEvidence && row.acquiredAt <= end && row.releasedAt > start).length, 0, 'a startup writer cannot overlap a read window');
        windows.push({ start, end });
      }
    } finally { await view.stop(); }
    const rows = trace(file);
    const holds = complete(rows);
    for (const window of windows) {
      assert.equal(holds.filter(row => row.command === 'api' && row.writeLockEvidence && row.acquiredAt <= window.end && row.releasedAt > window.start).length, 0,
        'the final stopped-server trace contains no writer overlapping any read window');
    }
    for (const label of Object.keys(samples)) {
      const runtime = rows.filter(row => row.kind === 'runtime' && row.command === label);
      assert.equal(runtime.length, 1, `${label} has one actual observed original CLI`);
      const board = holds.filter(row => row.command === label && row.board && row.writeLockEvidence);
      assert.ok(board.length > 0, `${label} has identified actual board-atomic holds`);
      assert.ok(board.every(row => row.pid === runtime[0].pid));
      samples[label].push(board.reduce((sum, row) => sum + row.heldMs, 0));
    }
    t.diagnostic(JSON.stringify({ kind: 'lock-budget-cycle', cycle, runtime: rows.filter(row => row.kind === 'runtime'),
      apiReadWindows: windows, nonAtomicHolds: holds.filter(row => !row.board),
      load: { cpus: cpus().length, average: loadavg(), freeMB: Math.round(freemem() / 1024 ** 2) } }));
    } finally {
      // Retain every record before cleanup even when a native command, HTTP assertion or parse failed.
      t.diagnostic(JSON.stringify({ kind: 'lock-budget-raw', cycle, raw: existsSync(file) ? readFileSync(file, 'utf8') : null }));
    }
  }
  for (const [label, values] of Object.entries(samples)) {
    assert.equal(values.length, N);
    const median = [...values].sort((a, b) => a - b)[1];
    t.diagnostic(JSON.stringify({ kind: 'lock-budget-command', label, samplesMs: values, medianMs: median, budgetMs: 1000 }));
    assert.ok(median < 1000, `${label} median cumulative actual board-held time ${median}ms exceeds 1000ms: ${JSON.stringify(values)}`);
  }
}
