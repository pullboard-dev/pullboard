/** Real fake-agent processes prove scaler launch custody, bounded worktree reuse and light enrollment [C7,B26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planWorkerScale } from '../../../../index.js';
import { workerWindowHours } from '../../../../index.js';
import * as store from '../../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../../tests/fixtures/land/board.js';
import { startFixtureChild } from '../../../../tests/fixtures/child.js';

/** Quote only private fixture paths for the actual supervisor's shell command. */
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** Use real Git and SQLite; each regime produces genuinely buildable light items. */
function fixture(t, hold) {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Scaler fixture';
  const box = helpers.project('true', isolated, { withWorktree: false });
  const records = join(box.dir, 'agent-records.jsonl');
  const release = join(box.dir, 'release-agents');
  const script = join(box.dir, 'fake-agent.cjs');
  writeFileSync(records, '');
  writeFileSync(script, `const fs=require('node:fs');\nconst records=${JSON.stringify(records)},release=${JSON.stringify(release)};\nconst joined=${JSON.stringify(hold)}?require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(join(import.meta.dirname, '../../../../pullboard.js'))},'join','web'],{cwd:process.cwd(),env:process.env,encoding:'utf8'}):{status:0};\nconst row={joined:joined.status,joinError:joined.stderr??'',seat:process.env.PULLBOARD_SEAT,root:process.cwd(),route:process.env.PULLBOARD_ROUTE,prompt:process.env.PULLBOARD_PROMPT,pid:process.pid};\nfs.appendFileSync(records,JSON.stringify({...row,event:'start'})+'\\n');\nlet ended=false;\nfunction finish(){if(ended)return;ended=true;fs.appendFileSync(records,JSON.stringify({...row,event:'end'})+'\\n');watcher?.close();}\nlet watcher;\nif(${JSON.stringify(hold)}){watcher=fs.watch(${JSON.stringify(box.dir)},()=>{if(fs.existsSync(release))finish();});if(fs.existsSync(release))finish();}\nelse finish();\n`);
  onBoard(box, board => {
    for (let index = 0; index < 12; index += 1) {
      const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Cold task ${index}`, route: 'mid',
        criterion: 'the named fix works', check: 'true', brief: 'Files: web/task.js\nTest: named assertion' });
      if (store.FACT_KINDS.includes('diagnosis')) store.appendFact(board, id, { agentId: 'coordinator', kind: 'diagnosis',
        text: 'Files: web/task.js Change: implement the named fix Test case: the task assertion succeeds' });
      else store.editItem(board, id, { agentId: 'coordinator', route: 'light', reason: 'Private light-worker fixture' });
    }
  });
  const settings = box.run(box.repo, 'settings', 'workers.budget', '96/day');
  assert.equal(settings.code, 0, settings.err);
  let child, closed;
  t.after(async () => {
    writeFileSync(release, 'release\n');
    if (closed) await closed;
    helpers.cleanup();
  });
  const run = () => {
    child = startFixtureChild(process.execPath, [join(import.meta.dirname, '../../../../pullboard.js'), 'run', '--scale', '--lane', 'web',
      '--model', 'Scaler fixture', '--family', 'Scaler fixture vendor', '--route', 'light', '--agent', `${quote(process.execPath)} ${quote(script)}`,
      '--cycles', '3', '--every', '5'], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = new Promise(resolve => child.once('close', resolve));
    let stdout = '', stderr = '', cycles = 0, buffered = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk; buffered += chunk;
      const lines = buffered.split('\n'); buffered = lines.pop();
      for (const line of lines) if (line.startsWith('workers:')) {
        cycles += 1;
        if (hold && cycles === 3) writeFileSync(release, 'release\n');
      }
    });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr, cycles })); });
  };
  return { box, records, run };
}

for (const hold of [true, false]) {
  test(`three actual scaler cycles ${hold ? 'count unjoined live agents once' : 'reuse ended agents without new worktrees'} [C7,B26]`, { timeout: 180_000 }, async t => { // budget: three native five-second cycles and private Git registration, not a throughput assertion.
    const f = fixture(t, hold);
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    assert.equal(result.cycles, 3);
    const rows = readFileSync(f.records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const starts = rows.filter(row => row.event === 'start');
    assert.equal(starts.length, hold ? 4 : 12, result.stdout);
    assert.equal(new Set(starts.map(row => row.root)).size, 4, 'ended agents reuse the same four worktrees');
    assert.equal(new Set(starts.map(row => row.seat)).size, 4, 'ordinary exits reuse their registered seat binding');
    assert.ok(starts.every(row => row.joined === 0), JSON.stringify(starts.map(row => row.joinError)));
    assert.ok(starts.every(row => row.route === 'light' && row.prompt.includes('--route light')));
    let active = 0, peak = 0;
    for (const row of rows) { active += row.event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
    assert.ok(peak <= 4, `at most four fake agents run concurrently; observed ${peak}`);
    assert.equal(active, 0, 'every owned fake process ended');
    const seats = onBoard(f.box, board => store.listAgents(board).filter(seat => seat.agent_lane === 'web'));
    assert.equal(seats.length, 4);
    assert.ok(seats.every(seat => seat.agent_route === 'light'), 'real native registration joins every launched seat light');
    const worktrees = f.box.git(f.box.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '));
    assert.ok(worktrees.length <= 4 + 2, `the target plus two bounds the worktree count: ${worktrees.length}`);
    assert.equal((result.stdout.match(/launching 4/gu) ?? []).length, hold ? 1 : 3);
  });
}

test('remaining window budget bounds the target independently of the sampling interval [C7,B26]', () => {
  const state = { budget: { spend: 40, window: 'day' }, usedSpend: 0, cycleHours: 1 / 60,
    hoursLeft: 10, worth: null, workers: [], reviews: 20, builds: 20 };
  assert.equal(planWorkerScale(state).target, 4);
  assert.equal(planWorkerScale({ ...state, hoursLeft: 20 }).target, 2);
  assert.equal(planWorkerScale({ ...state, budget: { spend: 1000, window: 'day' } }).target, 4, 'unknown worth never permits an unbounded fleet');
  assert.equal(planWorkerScale({ ...state, hoursLeft: 5, worth: 8 }).target, 8, 'a known measured worth retains its explicit capacity');
  const noon = Date.parse('2026-11-03T12:00:00.000Z');
  assert.equal(workerWindowHours('day', noon), 12);
  assert.equal(workerWindowHours('week', noon), 132);
});
