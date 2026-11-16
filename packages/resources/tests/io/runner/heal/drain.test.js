/** Real private queue custody drains one registered executor without changing live settings or holders [C7,Q1]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../../../../../gate/tests/fixtures/child.js';

/** Use a real private machine queue; fake executor names exercise admission without any network or live board. */
async function scenario(t, body) {
  const box = cellProject(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  const source = `import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { takeResource, listResources } from ${JSON.stringify(new URL('../../../../index.js', import.meta.url).href)};
import { runFixtureChildAsync, startFixtureChild } from ${JSON.stringify(new URL('../../../../../../packages/gate/tests/fixtures/child.js', import.meta.url).href)};
import { once } from 'node:events';
const root = process.cwd();
const runners = [{host:'drain-a',slots:2,browser:0},{host:'flow-b',slots:3,browser:1},{host:'guard-c',slots:2,browser:1}];
const base = {name:'gate',capacity:2,scope:'machine',root,remote:true,runnerOnly:true,runnerProvider:()=>runners};
const leases = [];
const pending = [];
const children = [];
let db;
/** Own and release only this fixture's lease. */
async function hold(host, agent) { const lease=await takeResource({...base,agent,requiredExecutor:{kind:'ssh',host}}); leases.push(lease); return lease; }
/** Read only the private pool returned by an actual lease. */
function connect(lease) { db=new DatabaseSync(lease.pool); db.exec('PRAGMA busy_timeout=1000'); }
/** A bounded poll is a hang ceiling for queue state, never a throughput measurement. */
async function until(read, label) { const stop=Date.now()+5000; while(Date.now()<stop) { const result=read(); if(result) return result; await pause(10); } throw new Error('private queue did not reach '+label); }
/** Exercise the two-minute policy using only this private request's recorded enqueue clock. */
function age(agent, ageMs=120001) { assert.equal(db.prepare('UPDATE waiter SET since=? WHERE agent=?').run(new Date(Date.now()-ageMs).toISOString(),agent).changes,1); }
/** Cancel through the public callback, so production removes its own waiter and reservation. */
function timing(agent, options={}, autoAge=true) { const control={cancel:false,aged:false,waiting:false}; const promise=takeResource({...base,timing:true,agent,item:'private-'+agent,...options,onWait(state){ if(control.cancel) throw new Error('private cancellation'); control.waiting=true; if(autoAge && !control.aged) {age(agent);control.aged=true;} }}); promise.then(lease=>leases.push(lease),()=>{}); pending.push({promise,control}); return {promise,control}; }
/** A different real process consults the same private durable reservation. */
async function ordinary(agent) {
  const script='import {takeResource} from '+JSON.stringify(${JSON.stringify(new URL('../../../../index.js', import.meta.url).href)})+'; const lease=await takeResource({...'+JSON.stringify({...base,runnerProvider:undefined})+',agent:'+JSON.stringify(agent)+',runnerProvider:()=>'+JSON.stringify(runners)+'}); console.log(JSON.stringify({host:lease.runner.host}));lease.release();';
  const result=await runFixtureChildAsync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:process.env,encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.context); return JSON.parse(result.stdout).host; }
try { ${body} }
finally { for(const child of children) if(child.exitCode===null && child.signalCode===null) child.kill('SIGTERM'); for(const entry of pending) entry.control.cancel=true; for(const lease of leases.reverse()) lease.release(); await Promise.allSettled(pending.map(entry=>entry.promise)); db?.close(); }
`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 20_000, // budget: only owned fixture children; a queue regression must not hang the suite.
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
}

test('an aged timing request drains the fewest-job host while ordinary jobs flow elsewhere [C7,Q1]', async t => {
  await scenario(t, `
const a=await hold('drain-a','a-holder'); connect(a);
await hold('flow-b','b-one'); await hold('flow-b','b-two');
await hold('guard-c','c-one'); await hold('guard-c','c-two');
const exclusive=timing('exclusive',{},false);
await until(()=>exclusive.control.waiting,'young timing waiter');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n,0,'a young request does not drain a host before two minutes');
assert.equal(await ordinary('before-two-minutes'),'drain-a','ordinary work still uses the spare slot before the drain threshold');
age('exclusive');
const drain=await until(()=>db.prepare('SELECT * FROM runner_timing_drain').get(),'drain reservation');
assert.equal(drain.host,'drain-a'); assert.ok(drain.wait_ms>=120000);
assert.equal(listResources({root}).find(row=>row.name==='gate').timingDrain.host,'drain-a');
for(let n=0;n<3;n++) assert.equal(await ordinary('flow-'+n),'flow-b','another process keeps using the other host, not refilling the draining host');
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE name='runner:drain-a'").get().n,1,'the original holder is not killed or evicted');
a.release();
const lease=await exclusive.promise;
assert.equal(lease.runner.host,'drain-a'); assert.equal(lease.timing,true);
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE name='runner:drain-a'").get().n,1);
assert.equal(await ordinary('while-exclusive'),'flow-b');
lease.release();
assert.equal(await ordinary('after-exclusive'),'drain-a','the drained host reopens after its exclusive holder releases');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n,0);
const events=db.prepare('SELECT kind,host,agent,item,wait_ms FROM runner_timing_event ORDER BY id').all();
assert.deepEqual(events.map(row=>row.kind),['drain-start','exclusive-admitted','exclusive-finished']);
const readable=listResources({root}).find(row=>row.name==='gate').timingEvents;
assert.deepEqual(readable.map(row=>row.kind),events.map(row=>row.kind),'completed drain evidence remains readable in status after reopening');
assert.ok(readable.every(row=>row.host==='drain-a' && row.waitMs>=120000));
assert.ok(events.every(row=>row.host==='drain-a' && row.agent==='exclusive' && row.item==='private-exclusive' && row.wait_ms>=120000));
`);
});

test('two timing requests retain one durable drain until the first exclusive holder leaves [C7,Q1]', async t => {
  await scenario(t, `
const a=await hold('drain-a','a-holder'); connect(a);
await hold('flow-b','b-one'); await hold('flow-b','b-two');
await hold('guard-c','c-one'); await hold('guard-c','c-two');
const first=timing('first'); await until(()=>db.prepare('SELECT * FROM runner_timing_drain').get(),'first drain');
const second=timing('second'); await until(()=>second.control.aged,'second aged waiter');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n,1);
assert.equal(db.prepare('SELECT agent FROM runner_timing_drain').get().agent,'first');
a.release(); const one=await first.promise;
for(let n=0;n<2;n++) assert.equal(await ordinary('other-'+n),'flow-b');
assert.equal(db.prepare('SELECT agent FROM runner_timing_drain').get().agent,'first','the second waiter cannot drain another host while the first exclusive hold is live');
assert.equal(db.prepare("SELECT count(*) AS n FROM runner_timing_event WHERE kind='drain-start'").get().n,1);
one.release(); const two=await second.promise;
assert.equal(two.runner.host,'drain-a');
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE timing=1").get().n,1);
two.release(); await ordinary('cleanup');
`);
});

test('drain cancellation preserves unavailable, browser and exact executor restrictions [C7,Q1]', async t => {
  await scenario(t, `
const a=await hold('drain-a','a-holder'); connect(a);
await hold('flow-b','b-holder'); await hold('guard-c','c-holder');
const restricted=timing('restricted',{browser:true,requiredExecutor:{kind:'ssh',host:'flow-b'}});
assert.equal((await until(()=>db.prepare('SELECT * FROM runner_timing_drain').get(),'restricted drain')).host,'flow-b');
db.prepare('INSERT INTO runner_unavailable(host,since,detail) VALUES(?,?,?)').run('flow-b',new Date().toISOString(),'private unavailable control');
await until(()=>!db.prepare('SELECT 1 FROM runner_timing_drain').get(),'incompatible reservation released');
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE agent='restricted'").get().n,0,'affinity is never redirected onto another host');
const browser=timing('browser',{browser:true});
assert.equal((await until(()=>db.prepare('SELECT * FROM runner_timing_drain').get(),'browser drain')).host,'guard-c','the no-browser and unavailable hosts remain ineligible');
browser.control.cancel=true; await assert.rejects(browser.promise,/private cancellation/);
assert.equal(await ordinary('cancel-cleanup'),'drain-a');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n,0);
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE agent IN ('a-holder','b-holder','c-holder')").get().n,3,'no existing holder was evicted');
restricted.control.cancel=true; await assert.rejects(restricted.promise,/private cancellation/);
assert.ok(db.prepare("SELECT count(*) AS n FROM runner_timing_event WHERE kind='drain-cancel'").get().n>=2);
`);
});


test('an old unfenced holder remains authoritative and prevents a false quiet receipt [C7,Q1]', async t => {
  await scenario(t, `
const {takeResource:legacyTake}=await import(${JSON.stringify(new URL('../../../../../../apps/cli/tests/fixtures/runners.js', import.meta.url).href)});
const old=await legacyTake({name:'runner:drain-a',capacity:2,scope:'machine',root,agent:'old-client'}); leases.push(old); connect(old);
await hold('flow-b','b-one'); await hold('flow-b','b-two');
await hold('guard-c','c-one'); await hold('guard-c','c-two');
const exclusive=timing('after-old');
assert.equal((await until(()=>db.prepare('SELECT * FROM runner_timing_drain').get(),'legacy drain')).host,'drain-a');
assert.equal(db.prepare('SELECT count(*) AS n FROM holder WHERE token=?').get(old.token).n,1,'unknown clients are counted, never evicted to create quiet');
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE agent='after-old'").get().n,0);
assert.equal(await ordinary('flow-around-old'),'flow-b');
old.release(); const lease=await exclusive.promise;
const evidence=lease.timingEvidence();
assert.equal(evidence.exclusive,false,'legacy activity remains explicitly unfenced even when that holder has left');
assert.ok(evidence.unfencedClients.some(row=>row.agent==='old-client'));
lease.release(); await ordinary('finalize-old');
`);
});

test('a dead private drain owner releases its reservation before ordinary admission [C7,Q1]', async t => {
  await scenario(t, `
const a=await hold('drain-a','a-holder'); connect(a);
await hold('flow-b','b-one'); await hold('flow-b','b-two');
await hold('guard-c','c-one'); await hold('guard-c','c-two');
const script='import {takeResource} from '+JSON.stringify(${JSON.stringify(new URL('../../../../index.js', import.meta.url).href)})+'; const lease=await takeResource({...'+JSON.stringify({...base,runnerProvider:undefined})+',timing:true,agent:"private-dead-owner",runnerProvider:()=>'+JSON.stringify(runners)+'});lease.release();';
const child=startFixtureChild(process.execPath,['--input-type=module','-e',script],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']}); children.push(child);
const closed=once(child,'close');
await until(()=>db.prepare("SELECT 1 FROM waiter WHERE agent='private-dead-owner'").get(),'private child queued');
age('private-dead-owner');
await until(()=>db.prepare("SELECT 1 FROM runner_timing_drain WHERE agent='private-dead-owner'").get(),'private child owns drain');
child.kill('SIGTERM'); await closed;
assert.equal(await ordinary('after-private-death'),'drain-a');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n,0);
assert.equal(db.prepare('SELECT count(*) AS n FROM holder WHERE token=?').get(a.token).n,1,'the unrelated original holder stays live');
assert.ok(db.prepare("SELECT count(*) AS n FROM runner_timing_event WHERE kind='drain-cancel' AND agent='private-dead-owner'").get().n>=1);
`);
});
