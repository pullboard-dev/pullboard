/** Native writer latency while landing snapshots share a real SQLite file [C7]. */
import assert from 'node:assert/strict';
import {
  dirname,
  join,
} from 'node:path';
import {
  pathToFileURL,
  fileURLToPath,
} from 'node:url';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import {
  startFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { boardWriteIoProblems } from '../../../../packages/gate/src/io/board/write.js';
import { styleSources } from '../../../../packages/codemap/index.js';

/** Start a warmed native writer and retain every message and its terminal outcome. */
function writer(t, file, kind, index, item, agent, commit) {
  const boardUrl = pathToFileURL(fileURLToPath(new URL('../../../../packages/store/index.js', import.meta.url))).href;
  const openUrl = pathToFileURL(fileURLToPath(new URL('../../../lib/index.js', import.meta.url))).href;
  const program = `import * as store from ${JSON.stringify(boardUrl)};
import {openBoard} from ${JSON.stringify(openUrl)};
const [file,kind,index,item,agent,commit]=process.argv.slice(1);
const board=openBoard(file);
let batch={version:1,id:'latency-progress',base:commit,tip:commit,root:${JSON.stringify(dirname(file))},branch:'refs/heads/main',items:[],owner:'latency-fixture',state:'gating',logPath:file+'.landing.log'};
let timer;
process.on('message', message=>{
 try {
  if(message==='stop') {clearInterval(timer);store.closeBoard(board);process.disconnect();return;}
  if(kind==='landing') {
   const progress=()=>{batch=store.recordLandingBatch(board,{agentId:'coordinator',batch,revision:batch.revision??0});process.send({progress:batch.revision});};
   progress();timer=setInterval(progress,100);return;
  }
  const started=performance.now();
  if(kind==='join') store.register(board,{lane:'core',path:'/latency/join-'+index,model:'Fixture Model'});
  if(kind==='claim') store.claim(board,Number(item),{agentId:agent,lane:'core',leaseMs:7200000,freeze:()=>({text:JSON.stringify({rows:[]}),digest:'latency-'+index})});
  if(kind==='fact') store.appendFact(board,Number(item),{agentId:'coordinator',kind:'note',text:'concurrent latency observation '+index});
  process.send({kind,elapsedMs:performance.now()-started});store.closeBoard(board);process.disconnect();
 } catch(error) {process.send({error:error.code??error.message});clearInterval(timer);store.closeBoard(board);process.disconnect();process.exitCode=1;}
});
process.send({ready:true});`;
  const child = startFixtureChild(process.execPath, ['--input-type=module', '-e', program, file, kind, String(index), String(item), agent, commit],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', bytes => { stderr += bytes; });
  const messages = [];
  const ready = new Promise(resolve => child.on('message', message => { messages.push(message); if (message.ready) resolve(); }));
  const closed = new Promise(resolve => child.once('close', code => resolve({ code, stderr, messages })));
  t.after(async () => { if (child.connected) child.send('stop'); await closed; });
  return { child, ready, closed, messages };
}

test('five native claim join and fact writes finish within 1 s while landing records progress [C7]', { timeout: 60_000 }, async t => {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const root = dirname(file);
  runFixtureGit(['init', '-q'], { cwd: root });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture source'], { cwd: root });
  const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim();
  store.register(board, { lane: 'coordinator', path: root });
  const agents = Array.from({ length: 2 }, (_, index) => store.register(board,
    { lane: 'core', path: join(root, `builder-${index}`), model: 'Fixture Model' }));
  const items = Array.from({ length: 2 }, (_, index) => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Latency claim ' + index }));
  const landing = writer(t, file, 'landing', 0, items[0], agents[0], commit);
  const writers = ['claim', 'join', 'fact', 'claim', 'join'].map((kind, index) => writer(t, file, kind, index,
    items[index === 3 ? 1 : 0], agents[index === 3 ? 1 : 0], commit));
  await Promise.all([landing, ...writers].map(entry => entry.ready));
  const progressed = new Promise(resolve => landing.child.on('message', message => { if (message.progress) resolve(); }));
  landing.child.send('go');
  await progressed;
  for (const entry of writers) entry.child.send('go');
  const results = await Promise.all(writers.map(entry => entry.closed));
  landing.child.send('stop');
  await landing.closed;
  for (const result of results) {
    assert.equal(result.code, 0, JSON.stringify(result));
    const measurement = result.messages.find(message => Number.isFinite(message.elapsedMs));
    assert.ok(measurement, JSON.stringify(result));
    assert.ok(measurement.elapsedMs < 1_000, JSON.stringify(measurement)); // budget: declared 1 s ceiling from frozen #2904
  }
  assert.ok(landing.messages.some(message => message.progress), 'landing recorded real native snapshots during the write window');
  console.log('native concurrent write measurements ' + JSON.stringify(results.map(result => result.messages.find(message => message.elapsedMs !== undefined))));
});

test('clause 2: native board writer call graph permits no git or test process under the transaction [C7]', () => {
  assert.deepEqual(boardWriteIoProblems(styleSources(fileURLToPath(new URL('../../../..', import.meta.url)))), []);
});
