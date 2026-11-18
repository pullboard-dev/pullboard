import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
/** Complete fresh-process CLI reads on a private board at the measured production scale [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
  loadavg,
  cpus,
} from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ceilings from '../../journeys/list/startup-budget.json' with { type: 'json' };
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { itemProgress } from '../../../../packages/roadmap/index.js';
import { runFixtureGit } from './child.js';
import { submitFixture } from './board/submit.js';

/** Seed real rows, not cached command results, with many historical submissions and a small live queue. */
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cli-startup-budget-')));
  let db;
  // A detached writer can still be flushing when teardown starts, so the removal retries ENOTEMPTY and EBUSY like verdict-check.js.
  t.after(() => { db?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 }); });
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
  for (let n = 0; n < 45000; n++) event.run(at, `core-${1 + n % 800}`, n < 1600 ? 'submit' : n % 2 ? 'claim' : 'edit', 1 + n % 1000, n < 1600 ? proof : '{}');
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


/** Every command the startup budgets measure, in measuring order. */
export const STARTUP_COMMANDS = ['version', 'show', 'status', 'list', 'list thin'];

/** The commands one call measures: all five by default, or the ones `options.only` names (an unknown name is refused, not skipped). */
export function startupCommands(options = {}) {
  const only = options.only ?? STARTUP_COMMANDS;
  const unknown = only.filter(name => !STARTUP_COMMANDS.includes(name));
  if (unknown.length) throw new Error(`assertStartupBudgets: unknown command ${unknown.join(', ')}; choose from ${STARTUP_COMMANDS.join(', ')}`);
  return STARTUP_COMMANDS.filter(name => only.includes(name));
}

/**
 * Measure complete fresh CLI processes without a module hook, warmup, or output shortcut.
 * `options.only` names the commands to measure (the bare node floor is always timed); no option measures all five, because one call over all
 * of them outran its file timeout on an 800-seat board and a row needs a file of its own [C7,#9477].
 */
export async function assertStartupBudgets(t, sink = {}, options = {}) {
  const cleanups=[];
  const {root,db}=fixture({after(fn){cleanups.push(fn);}});
  try {
    const code=resolve(import.meta.dirname,'../../pullboard.js');
    const initial=boardDigest(db);
    const expectedItems=JSON.parse(JSON.stringify(store.listItems({db,clock:store.systemClock})));
    const board={db,clock:store.systemClock};
    // Item 4's seeded submissions at n=3 and n=1003 name core-4 and core-204.
    // Every other independently seeded seat is eligible under the fixture's Standard/off policy.
    const authors=['core-204','core-4'];
    const eligibility={tier:'standard',requiredFamily:null,ready:true,
      eligible:['coordinator',...Array.from({length:800},(_,index)=>`core-${index+1}`)]
        .filter(agent=>!authors.includes(agent)).sort(),
      ineligible:authors.map(agent=>({agent,code:'SELF_VERIFY',
        rule:'[SELF_VERIFY] the builder never verifies its own work; another agent must'})),
      // show names the authors' parent sessions (#4485cb6b7c); seats that joined with no parent group under 'unknown' [C7].
      authorParents:[{parent:'unknown',seats:['core-4','core-204']}]};
    const expectedShow=JSON.parse(JSON.stringify({version:1,...store.getItem(board,4),verdicts:store.verdictsFor(board,4),
      thread:store.itemThread(board,4),progress:itemProgress(board,4),machineVerification:null,checkText:'',agentApproved:[],approvalQualification:'',reviewEligibility:eligibility}));
    const samples=Object.fromEntries(startupCommands(options).map(name=>[name,[]]));
    // 'list thin' is list with list.thinRead on in the child's machine settings; the file exists only while that child runs [C7,#9090].
    const settingsFile=join(root,'private-machine','settings.json');
    const childEnvironment={...process.env,PULLBOARD_FIXTURE_BOARD:'1',PULLBOARD_HOME:join(root,'private-home'),PULLBOARD_MACHINE_HOME:join(root,'private-machine'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
    for(const name of ['PULLBOARD_RELAY_TOKEN','PULLBOARD_RELAY_KEY']) delete childEnvironment[name];
    // Bare node (node -e 0, same env and child API) is the floor no import cut can beat; it is timed once per round next to every row [C7].
    const bareSamples=[];
    for(let round=0;round<5;round++) {
      const bareStarted=performance.now();
      const bare=spawnSync(process.execPath,['-e','0'],{cwd:root,encoding:'utf8',env:childEnvironment});
      bareSamples.push(performance.now()-bareStarted);
      assert.equal(bare.status,0,`bare node round ${round}: ${bare.error?.message ?? bare.stderr}`);
      for(const name of Object.keys(samples)) {
      const thin=name==='list thin';
      const args=name==='version'?['--version','--json']:name==='show'?['show','4','--json']:[thin?'list':name,'--json'];
      if(thin){ mkdirSync(join(root,'private-machine'),{recursive:true}); writeFileSync(settingsFile,JSON.stringify({list:{thinRead:true}})); }
      const started=performance.now();
      const result=spawnSync(process.execPath,[code,...args],{cwd:root,encoding:'utf8',env:childEnvironment,maxBuffer:16*1024*1024});
      const milliseconds=performance.now()-started;
      if(thin) unlinkSync(settingsFile);
      assert.equal(result.status,0,`${name} round ${round}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
      const data=JSON.parse(result.stdout);
      assert.equal(data.version,1);
      // Idle minutes are read from the clock, so only that one field follows the wall time; every other progress field is exact.
      if(name==='show') assert.deepEqual({...data,progress:{...data.progress,idleMinutes:expectedShow.progress.idleMinutes}},expectedShow,'the complete item, verdicts and thread survive the startup optimization');
      if(name==='status') assert.equal(data.stats.items.submitted,10);
      if(name==='list'||thin) {
        assert.equal(data.items.length,1000);
        assert.deepEqual(data.items,expectedItems,'the complete list rows survive the startup optimization');
      }
      samples[name].push(milliseconds);
      }
    }
    assert.equal(boardDigest(db),initial,'all persistent board rows remain unchanged');
    const medians=Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,[...values].sort((a,b)=>a-b)[2]]));
    const report={code,node:process.version,method:'end-to-end real child process, round-robin five, no warmup; full stdout+JSON assertions',population:{items:1000,events:db.prepare('SELECT count(*) AS n FROM event').get().n,shouts:23000,agents:801,historicalSubmits:1600,landingBatches:0},samplesMs:samples,mediansMs:medians,load:loadavg(),cpus:cpus().length,boardSha256:initial};
    t.diagnostic(JSON.stringify(report));
    const bareMedian=[...bareSamples].sort((a,b)=>a-b)[2];
    report.bareNodeMs=bareSamples;
    report.bareNodeMedianMs=bareMedian;
    report.floorLines=Object.entries(medians).map(([name,median])=>`${name} median ${median.toFixed(2)} ms, bare node median ${bareMedian.toFixed(2)} ms, overhead ${(median-bareMedian).toFixed(2)} ms`);
    for (const line of report.floorLines) t.diagnostic(line);
    // The report is handed out before any ceiling assertion, so a row over its ceiling still leaves its floor readable.
    Object.assign(sink, report);
    // Goal: 100 ms (#1048). Each row is an audited exception at its measured runner median (#5994); rows only go down, and the 0.9.5 de-barrel item brings them to the goal.
    for (const [name, median] of Object.entries(medians)) {
      assert.ok(median < ceilings[name], `${name} end-to-end median ${median.toFixed(2)} ms exceeds its ${ceilings[name]} ms row in startup-budget.json (goal 100 ms)`);
      if (median < 100) t.diagnostic(`${name} median ${median.toFixed(2)} ms meets the 100 ms goal; lower its row in startup-budget.json to 100`);
    }
    return report;
  } finally { for(const fn of cleanups.reverse())fn(); }
}
