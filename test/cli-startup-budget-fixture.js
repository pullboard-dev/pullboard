import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
/** Complete fresh-process CLI reads on a private board at the measured production scale [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, loadavg, cpus } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../src/board.js';
import { runFixtureGit } from './fixture-child.js';
import { submitFixture } from './board-submit-fixture.js';

/** Seed real rows, not cached command results, with many historical submissions and a small live queue. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cli-startup-budget-')));
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
  const board = store.openBoard(file);
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
  for (let n = 0; n < 45000; n++) event.run(at, `core-${1 + n % 800}`, n < 1600 ? 'submit' : n % 2 ? 'claim' : 'edit', 1 + n % 1000, n < 1600 ? proof : '{}');
  const shout = db.prepare('INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < 23000; n++) shout.run(`core-${1 + n % 800}`, 'all', `Board activity ${n}`, at);
  db.exec('COMMIT');
  const live = store.openBoard(file);
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


/** Measure complete fresh CLI processes without a module hook, warmup, or output shortcut. */
export async function assertStartupBudgets(t) {
  const cleanups=[];
  const {root,db}=fixture({after(fn){cleanups.push(fn);}});
  try {
    const code=resolve(import.meta.dirname,'../bin/pullboard.js');
    const initial=boardDigest(db);
    const expectedItems=JSON.parse(JSON.stringify(store.listItems({db,clock:store.systemClock})));
    const board={db,clock:store.systemClock};
    const expectedShow=JSON.parse(JSON.stringify({version:1,...store.getItem(board,4),verdicts:store.verdictsFor(board,4),
      thread:store.itemThread(board,4),checkText:'',agentApproved:[],approvalQualification:''}));
    const samples={version:[],show:[],status:[],list:[]};
    const childEnvironment={...process.env,PULLBOARD_HOME:join(root,'private-home'),PULLBOARD_MACHINE_HOME:join(root,'private-machine'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
    for(const name of ['PULLBOARD_RELAY_TOKEN','PULLBOARD_RELAY_KEY']) delete childEnvironment[name];
    for(let round=0;round<5;round++) for(const name of Object.keys(samples)) {
      const args=name==='version'?['--version','--json']:name==='show'?['show','4','--json']:[name,'--json'];
      const started=performance.now();
      const result=spawnSync(process.execPath,[code,...args],{cwd:root,encoding:'utf8',env:childEnvironment,maxBuffer:16*1024*1024});
      const milliseconds=performance.now()-started;
      assert.equal(result.status,0,`${name} round ${round}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
      const data=JSON.parse(result.stdout);
      assert.equal(data.version,1);
      if(name==='show') assert.deepEqual(data,expectedShow,'the complete item, verdicts and thread survive the startup optimization');
      if(name==='status') assert.equal(data.stats.items.submitted,10);
      if(name==='list') {
        assert.equal(data.items.length,1000);
        assert.deepEqual(data.items,expectedItems,'the complete list rows survive the startup optimization');
      }
      samples[name].push(milliseconds);
    }
    assert.equal(boardDigest(db),initial,'all persistent board rows remain unchanged');
    const medians=Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,[...values].sort((a,b)=>a-b)[2]]));
    const report={code,node:process.version,method:'end-to-end real child process, round-robin five, no warmup; full stdout+JSON assertions',population:{items:1000,events:db.prepare('SELECT count(*) AS n FROM event').get().n,shouts:23000,agents:801,historicalSubmits:1600,landingBatches:0},samplesMs:samples,mediansMs:medians,load:loadavg(),cpus:cpus().length,boardSha256:initial};
    t.diagnostic(JSON.stringify(report));
    for (const [name, median] of Object.entries(medians)) assert.ok(median < 100, `${name} end-to-end median ${median.toFixed(2)} ms exceeds 100 ms`); // budget: declared #1048 five-run fresh-process criterion; baseline measured 106-176 ms on the same seeded shape.
  } finally { for(const fn of cleanups.reverse())fn(); }
}
