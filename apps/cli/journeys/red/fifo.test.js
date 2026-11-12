/** A red item check remains mandatory and compares its failed files with main for recovery guidance [V1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { FAILING_TEST } from '../../tests/fixtures/red/main-red.js';
import { RED_SPEC } from '../../tests/fixtures/red/main-red.js';
import { cli } from '../../tests/fixtures/red/main-red.js';
import { commit } from '../../tests/fixtures/red/main-red.js';
import { fixture } from '../../tests/fixtures/red/main-red.js';
import { put } from '../../tests/fixtures/red/main-red.js';

test("a red submit's comparisons keep FIFO and release between files [V4,C7]", async t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST });
  const control = join(box.directory, 'control');
  mkdirSync(control);
  const log = join(box.directory, 'order.jsonl');
  const queue = join(box.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite');
  box.env.COMPARE_CONTROL = control;
  box.env.COMPARE_ORDER = log;
  assert.equal(cli(box.root, box.env, 'settings', 'gateSlots', '2').code, 0);
  put(box.root, 'test/unrelated.test.js', "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");
  put(box.root, 'test/runner.js', [
    "import { appendFileSync, existsSync } from 'node:fs';",
    "import { basename, join } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    "const file = process.argv[2]; const name = basename(file);",
    "appendFileSync(process.env.COMPARE_ORDER, JSON.stringify({phase:'start',name}) + '\\n');",
    "while (!existsSync(join(process.env.COMPARE_CONTROL, name + '.release'))) await new Promise(done => setTimeout(done, 10));",
    "const run = spawnSync(process.execPath, ['--test', file], { encoding:'utf8', env:process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    "appendFileSync(process.env.COMPARE_ORDER, JSON.stringify({phase:'finish',name}) + '\\n');",
    "process.exitCode = run.status ?? 1;",
  ].join('\n'));
  const main = commit(box.root, box.env);
  const driver = join(box.directory, 'queue-driver.mjs');
  writeFileSync(driver, [
    `import { takeResource } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href)};`,
    `import { compareMainFailures } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/src/io/main/red.js')).href)};`,
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const [mode, root] = process.argv.slice(2); const control = process.env.COMPARE_CONTROL;",
    "/** Await only a parent-owned handshake, leaving no uncontrolled fixture work. */",
    "async function released(name) { while (!existsSync(join(control, name))) await new Promise(done => setTimeout(done, 10)); }",
    "if (mode === 'blocker') {",
    "  const first = await takeResource({name:'gate',capacity:2,root});",
    "  const second = await takeResource({name:'gate',capacity:2,root});",
    "  writeFileSync(join(control,'blocker.ready'),'ready');",
    "  try { await released('blocker.first'); first.release(); await released('blocker.second'); }",
    "  finally { first.release(); second.release(); }",
    "} else if (mode === 'check') {",
    "  const lease = await takeResource({name:'gate',capacity:2,root,itemCheck:true,agent:'independent-check'});",
    "  try { appendFileSync(process.env.COMPARE_ORDER, JSON.stringify({phase:'start',name:'item-check'}) + '\\n'); await released('check.release'); }",
    "  finally { lease.release(); }",
    "} else {",
    "  const profile = {tests:['test/inherited.test.js','test/unrelated.test.js'].map(file => ({file,passed:false}))};",
    "  const result = await compareMainFailures(root,profile);",
    "  writeFileSync(join(control,mode + '.result'),JSON.stringify(result));",
    "}",
  ].join('\n'));
  const children = [];
  let maximum = 0;
  let comparison;
  /** Read the real private resource queue without changing its leases. */
  const entries = table => {
    if (!existsSync(queue)) return [];
    const db = new DatabaseSync(queue, { readOnly: true });
    try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10000'); return db.prepare(`SELECT * FROM ${table} WHERE name='gate'`).all(); }
    finally { db.close(); }
  };
  /** Retain actual completion and stderr for every bounded fixture child. */
  const launchQueue = mode => {
    const child = startFixtureChild(process.execPath, [driver, mode, box.root], { cwd: box.root, env: box.env, stdio: ['ignore','pipe','pipe'] });
    let error = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', part => { error += part; });
    child.done = new Promise(resolve => child.once('close', code => resolve({code,error})));
    children.push(child); return child;
  };
  /** Wait for evidence, not a throughput deadline, while recording the comparison's actual holders. */
  const observed = async (predicate, label) => {
    const deadline = Date.now() + 20_000; // budget: hang ceiling for real resource/file handshakes, not a speed assertion.
    while (!predicate() && Date.now() < deadline) {
      maximum = Math.max(maximum, entries('holder').filter(row => row.pid === comparison?.pid).length);
      await new Promise(done => setTimeout(done, 10));
    }
    maximum = Math.max(maximum, entries('holder').filter(row => row.pid === comparison?.pid).length);
    assert.ok(predicate(), label);
  };
  /** Read complete append-only records written by native comparison runners. */
  const order = () => existsSync(log) ? readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  /** Release only this fixture's blocked work on both assertion success and failure. */
  const release = name => writeFileSync(join(control,name),'release');
  try {
    launchQueue('blocker');
    await observed(() => existsSync(join(control,'blocker.ready')), 'both private fixture slots are held');
    comparison = launchQueue('comparison');
    await observed(() => entries('waiter').some(row => row.pid === comparison.pid), 'the red comparison queues first');
    const check = launchQueue('check');
    await observed(() => entries('waiter').some(row => row.pid === check.pid), 'a different item check queues later');
    assert.equal(entries('waiter').filter(row => row.pid === comparison.pid).length, 1, 'one submit queues only one comparison lease');
    release('blocker.first');
    await observed(() => order().length > 0, 'one queued job begins in the released slot');
    const first = order()[0].name;
    assert.notEqual(first, 'item-check', 'the older diagnostic keeps its ticket ahead of the later item check');
    assert.equal(entries('holder').filter(row => row.pid === comparison.pid).length, 1);
    assert.equal(entries('waiter').filter(row => row.pid === comparison.pid).length, 0, 'no second diagnostic is queued while the first owns a slot');
    release(first + '.release');
    await observed(() => order().some(row => row.name === 'item-check' && row.phase === 'start')
      && entries('waiter').some(row => row.pid === comparison.pid), 'the older queued item check starts before the newly queued second diagnostic');
    assert.equal(order().filter(row => row.name !== 'item-check' && row.phase === 'start').length, 1,
      'the second diagnostic waits while the older item check holds the only available slot');
    assert.equal(entries('holder').filter(row => row.pid === comparison.pid).length, 0,
      'the comparison releases its lease between files');
    assert.equal(entries('holder').filter(row => row.pid === check.pid).length, 1);
    assert.deepEqual(order().slice(0,3).map(({phase,name}) => [phase,name]), [
      ['start', first], ['finish', first], ['start', 'item-check'],
    ]);
    assert.ok(JSON.parse(readFileSync(join(box.root,'.git/pullboard/main-red.json'),'utf8')).entries[main]['test/' + first],
      'the first result is persisted before the next comparison acquires');
    release('check.release');
    await observed(() => order().filter(row => row.name !== 'item-check' && row.phase === 'start').length === 2,
      'the second diagnostic starts after the older item check releases');
    const beforeSecond = order().filter(row => row.name !== 'item-check');
    assert.deepEqual(beforeSecond.slice(0,3).map(row => row.phase), ['start','finish','start']);
    release('blocker.second');
    release('inherited.test.js.release'); release('unrelated.test.js.release');
    await observed(() => existsSync(join(control,'comparison.result')), 'both diagnostic results finish');
    assert.equal(maximum, 1, 'one submit never holds two machine slots');
    assert.deepEqual(JSON.parse(readFileSync(join(control,'comparison.result'),'utf8')), { main, files: [
      {file:'test/inherited.test.js',result:'red'}, {file:'test/unrelated.test.js',result:'green'},
    ] });
    const count = order().length;
    launchQueue('cached');
    await observed(() => existsSync(join(control,'cached.result')), 'cached results remain reusable');
    assert.equal(order().length, count, 'the exact-main cache runs no comparison again');
  } finally {
    for (const name of ['blocker.first','blocker.second','check.release','inherited.test.js.release','unrelated.test.js.release']) release(name);
    for (const child of children) {
      const result = await child.done;
      assert.equal(result.code, 0, result.error);
    }
  }
});

