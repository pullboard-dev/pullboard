/** A red item check remains mandatory and compares its failed files with main for recovery guidance [V1,V4]. */
import assert from 'node:assert/strict';
import '../src/main-red.js'; // The private driver below invokes this production entry point.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { runFixtureChild, runFixtureGit, startFixtureChild } from './fixture-child.js';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Write one file under a fixture repository, creating its parent directories. */
function put(root, path, value) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

/** Run the real CLI in a private checkout and preserve its separate output streams. */
function cli(root, env, ...args) {
  const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
}

/** Commit fixture state with the isolated test identity and the requested spec citation. */
function commit(root, env, subject = 'chore: fixture state') {
  runFixtureGit(['add', '-A'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '-m', subject], { cwd: root, env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env }).trim();
}

/** Count real runner calls separately from the bar-baseline calls made while defining items. */
function runCount(box) {
  return existsSync(box.env.MAIN_RED_RUNS) ? readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length : 0;
}

/** Quote one executable path for the fixture's real CLI shim. */
function shellWord(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

/** Create a private real-Git board with a selected native Node test command. */
function fixture(t, { spec, source, affectedTests = 'node test/runner.js', reporter, requireInfraNote = false }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-main-red-')));
  roots.push(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Agent', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture Agent', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    PULLBOARD_MODEL: 'Fixture Model', MAIN_RED_RUNS: join(directory, 'main-runs.log'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  assert.equal(cli(root, env, 'init').code, 0);
  put(root, 'pullboard.json', JSON.stringify({
    gate: 'node test/runner.js',
    ...(requireInfraNote ? { submit: { requireInfraNote: true } } : {}),
    ...(affectedTests ? { affectedTests } : {}),
    lanes: { core: { owns: ['test/'], specs: ['G'] } },
  }, null, 2) + '\n');
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'SPEC.md', spec);
  put(root, 'test/inherited.test.js', source);
  put(root, 'test/runner.js', [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "if (process.env.MAIN_RED_RUNS) appendFileSync(process.env.MAIN_RED_RUNS, `${process.cwd()}\\n`);",
    "const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test/inherited.test.js'];",
    `const result = spawnSync(process.execPath, ['--test', ...${JSON.stringify(reporter ? [`--test-reporter=${reporter}`] : [])}, ...files], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });`,
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    'process.exitCode = result.status ?? 1;',
  ].join('\n') + '\n');
  commit(root, env);
  return { directory, root, env };
}

/** Add each specified item through the actual coordinator CLI. */
function addItems(box, rows) {
  return rows.map(({ title, specId, route = 'mid' }) => {
    const file = { G1: 'test/inherited.test.js', G2: 'test/unrelated.test.js', G3: 'test/earlier.test.js', G4: 'test/middle.test.js' }[specId];
    const result = cli(box.root, box.env, 'add', 'core', title, '--specs', specId, '--route', route,
      // These recovery cases exercise an unsatisfied item check; inherited proof failures have separate acceptance coverage.
      '--criterion', title, '--check', 'node test/runner.js', '--brief', `Files: ${file}\nTest: ${title}`);
    assert.equal(result.code, 0, result.err || result.out);
    return Number(/^#(\d+)$/mu.exec(result.out)?.[1]);
  });
}

/** Create and join a real builder worktree through Pullboard. */
function builder(box) {
  const made = cli(box.root, box.env, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model', '--json');
  assert.equal(made.code, 0, made.err || made.out);
  const root = JSON.parse(made.out).path;
  return { root, run: (...args) => cli(root, box.env, ...args) };
}

/** Assert the public refusal identifies both next steps and excludes false unique attribution. */
function inheritedMessage(result, { row, item, testFile = 'test/inherited.test.js' } = {}) {
  assert.equal(result.code, 1, result.out || result.err);
  assert.match(result.err, /\[GATE_RED\]/u);
  assert.match(result.err, /also red on main|inherited main red/u);
  assert.match(result.err, new RegExp(testFile.replaceAll('.', '\\.'), 'u'));
  if (row && item) {
    assert.match(result.err, new RegExp(`approved row ${row} .*open rework #${item} owns it`, 'u'));
    assert.ok(result.err.trimEnd().endsWith(`next: land #${item} first, then submit again`));
    assert.equal((result.err.match(/^next: /gmu) ?? []).length, 1, 'the specific recovery is printed once');
  } else {
    assert.doesNotMatch(result.err, /approved row|open rework #\d+/u);
  }
}

const RED_SPEC = [
  '# Main red fixture\n\n## G · Goals',
  '- G1 [approved, must] The inherited test proves the row. | gate: test/inherited.test.js',
  '- G2 [approved, must] An unrelated change has a separate test. | gate: test/unrelated.test.js',
  '- G3 [approved, must] Earlier milestone work has a separate row. | gate: test/earlier.test.js',
  '- G4 [approved, must] Middle milestone work has a separate row. | gate: test/middle.test.js',
].join('\n') + '\n';
const FAILING_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "test('the inherited behavior remains broken [V1]', () => assert.equal(1, 2));",
].join('\n') + '\n';

test('main comparisons use the free CPU slot while browser work keeps its browser slot [V1,C7]', async t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST });
  for (const [key, value] of [['gateSlots', '2'], ['browserSlots', '1']]) {
    const set = cli(box.root, box.env, 'settings', key, value);
    assert.equal(set.code, 0, `${key}: ${set.err}`);
  }
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.gate = { ...settings.gate, browserFreeChecks: true };
  writeFileSync(settingsFile, JSON.stringify(settings) + '\n', { mode: 0o600 });
  put(box.root, 'test/browser.test.js', [
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { test } from 'node:test';",
    '/** A potentially reachable Chrome launch makes this an admission fixture, without launching it here. */',
    "export function browserLaunch() { return spawnSync('google-chrome', []); }",
    "test('browser-capable comparison stays red [V1]', () => assert.equal(1, 2));",
  ].join('\n') + '\n');
  const main = commit(box.root, box.env);
  const control = join(box.directory, 'cpu-browser-control');
  mkdirSync(control);
  const queue = join(box.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite');
  const driver = join(box.directory, 'cpu-browser-driver.mjs');
  writeFileSync(driver, [
    `import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/gate.js')).href)};`,
    `import { compareMainFailures } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/main-red.js')).href)};`,
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [mode, root, control] = process.argv.slice(2);',
    "if (mode === 'holder') {",
    '  await withGateSlot(root, async lease => {',
    "    if (!lease.browser) throw new Error('the fixture requires a real browser lease');",
    "    writeFileSync(join(control,'browser.ready'),'ready');",
    "    while (!existsSync(join(control,'browser.release'))) await new Promise(done => setTimeout(done,10));",
    "  }, {browser:true,remote:false,agent:'fixture-browser-holder'});",
    '} else {',
    "  const file = mode === 'cpu' ? 'test/inherited.test.js' : 'test/browser.test.js';",
    '  const result = await compareMainFailures(root,{tests:[{file,passed:false}]});',
    "  writeFileSync(join(control,mode + '.result'),JSON.stringify(result));",
    '}',
  ].join('\n'));
  const children = [];
  /** Observe only the private fixture's real lease rows, without changing any admission state. */
  const entries = table => {
    if (!existsSync(queue)) return [];
    const db = new DatabaseSync(queue, { readOnly: true });
    try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10000'); return db.prepare(`SELECT * FROM ${table} WHERE name='gate'`).all(); }
    finally { db.close(); }
  };
  /** Launch a product comparison or a genuine private browser lease and retain its terminal result. */
  const launch = mode => {
    const child = startFixtureChild(process.execPath, [driver, mode, box.root, control], { cwd: box.root, env: box.env, stdio: ['ignore','pipe','pipe'] });
    let error = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', part => { error += part; });
    child.done = new Promise(resolve => child.once('close', code => resolve({code,error})));
    children.push(child);
    return child;
  };
  /** Await actual admission or completion, using a hang ceiling rather than a speed assertion. */
  const observed = async (predicate, label) => {
    const deadline = Date.now() + 20_000; // budget: private resource/file handshake hang ceiling, not a speed target.
    while (!predicate() && Date.now() < deadline) await new Promise(done => setTimeout(done,10));
    assert.ok(predicate(), label);
  };
  try {
    const holder = launch('holder');
    await observed(() => existsSync(join(control,'browser.ready')), 'one real browser slot is occupied');
    const cpu = launch('cpu');
    await observed(() => existsSync(join(control,'cpu.result')) || [...entries('waiter'),...entries('holder')].some(row => row.pid === cpu.pid), 'the CPU comparison requests real admission');
    const requested = [...entries('waiter'),...entries('holder')].find(row => row.pid === cpu.pid);
    if (requested) assert.equal(requested.browser, 0, 'a CPU-only main comparison does not request the occupied browser slot');
    await observed(() => existsSync(join(control,'cpu.result')), 'the CPU comparison completes while browser work stays admitted');
    assert.equal(entries('holder').find(row => row.pid === holder.pid)?.browser, 1, 'the original browser job still owns its lease');
    assert.deepEqual(JSON.parse(readFileSync(join(control,'cpu.result'),'utf8')), {main,files:[{file:'test/inherited.test.js',result:'red'}]});
    const browser = launch('browser');
    await observed(() => entries('waiter').some(row => row.pid === browser.pid && row.browser === 1), 'a browser-capable file still queues for the browser lease');
    assert.equal(existsSync(join(control,'browser.result')), false, 'browser work never uses the spare CPU slot as a browser bypass');
    writeFileSync(join(control,'browser.release'),'release');
    await observed(() => existsSync(join(control,'browser.result')), 'browser comparison completes after its real lease becomes available');
    assert.deepEqual(JSON.parse(readFileSync(join(control,'browser.result'),'utf8')), {main,files:[{file:'test/browser.test.js',result:'red'}]});
  } finally {
    writeFileSync(join(control,'browser.release'),'release');
    for (const child of children) {
      const result = await child.done;
      assert.equal(result.code, 0, result.error);
    }
  }
});

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
    `import { takeResource } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/resources.js')).href)};`,
    `import { compareMainFailures } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/main-red.js')).href)};`,
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

test('an inherited red reads native spec reporter failure locations [V1]', t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST, reporter: 'spec', requireInfraNote: true });
  delete box.env.NO_COLOR;
  box.env.FORCE_COLOR = '1';
  const [rework, submitItem] = addItems(box, [
    { title: 'Repair spec-reported failure', specId: 'G1' },
    { title: 'Unrelated submit', specId: 'G2' },
  ]);
  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
  commit(submitter.root, box.env, 'test(core): select spec-reported red [G2]');
  const before = runCount(box);
  const unexplained = submitter.run('submit', String(submitItem));
  assert.match(unexplained.err, /\[INFRA_NOTE_REQUIRED\]/u, 'test edits need an explanation before any inherited-red comparison');
  const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise native spec failure reporting');
  inheritedMessage(red, { row: 'G1', item: rework });
  const refusedItem = JSON.parse(submitter.run('show', String(submitItem), '--json').out);
  assert.equal(refusedItem.thread.some(entry => entry.kind === 'submit'), false, 'a red gate records no successful submit or infra note');
  assert.equal(runCount(box), before + 2,
    'the unchanged spec reporter command runs once on the candidate and once on exact main');
});

test('a red with unreadable failure files says why main was not checked [V1]', t => {
  const box = fixture(t, { spec: RED_SPEC, source: FAILING_TEST });
  put(box.root, 'test/runner.js', [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.MAIN_RED_RUNS, `${process.cwd()}\\n`);",
    "console.error('A runner failed without a failure-file report.');",
    "console.error('test at test/inherited.test.js:3:1');",
    'process.exitCode = 1;',
  ].join('\n') + '\n');
  commit(box.root, box.env);
  const [, submitItem] = addItems(box, [
    { title: 'Repair unknown runner failure', specId: 'G1' },
    { title: 'Unrelated submit', specId: 'G2' },
  ]);
  const submitter = builder(box);
  assert.equal(submitter.run('claim', String(submitItem)).code, 0);
  put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
  commit(submitter.root, box.env, 'test(core): select unreadable runner red [G2]');
  const before = runCount(box);
  const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise unreadable runner failure reporting');
  assert.equal(red.code, 1, red.out || red.err);
  assert.match(red.err, /\[GATE_RED\]/u);
  assert.match(red.err, /main not checked: could not read which tests failed/u);
  assert.doesNotMatch(red.err, /also red on main|inherited main red/u);
  assert.equal(runCount(box), before + 1,
    'a location outside the spec reporter failure footer is not guessed to be a failed file');
});

test('an inherited red names the rework that owns it [V1]', async (t) => {
  await t.test('a prioritized rework already first in its tier stays first [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST });
    const [rework, submitItem] = addItems(box, [
      { title: 'First same-tier rework', specId: 'G1' },
      { title: 'Second same-tier submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): capture inherited red [G1]');
    inheritedMessage(submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise prioritized inherited rework'), { row: 'G1', item: rework });
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, rework);
  });

  await t.test('one inherited row names its open owner, reuses exact-main cache, and leads only within its tier [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST });
    const [rework, submitItem, earlier, middle] = addItems(box, [
      { title: 'Repair inherited gate', specId: 'G1' },
      { title: 'Unrelated submit', specId: 'G2' },
      { title: 'Earlier light work', specId: 'G3', route: 'light' },
      { title: 'Middle milestone work', specId: 'G4' },
    ]);
    assert.ok(rework && submitItem && earlier && middle);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Middle', '--items', String(middle)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--items', String(rework)).code, 0);

    const withoutEvidence = builder(box);
    const ordinary = withoutEvidence.run('next', '--json');
    assert.equal(ordinary.code, 0, ordinary.err);
    assert.equal(JSON.parse(ordinary.out).item.item_id, earlier, 'without current-main evidence, original milestone order remains unchanged');
    const normalMid = builder(box);
    const normalOffer = normalMid.run('next', '--json');
    assert.equal(normalOffer.code, 0, normalOffer.err);
    assert.equal(JSON.parse(normalOffer.out).item.item_id, middle, 'without evidence, same-tier milestone order remains unchanged');
    assert.equal(normalMid.run('release', String(middle)).code, 0);

    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select inherited red [G1]');
    const before = runCount(box);
    let red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise exact-main comparison caching');
    inheritedMessage(red, { row: 'G1', item: rework });
    const main = runFixtureGit(['rev-parse', 'main'], { cwd: box.root, env: box.env }).trim();
    const common = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: submitter.root, env: box.env }).trim();
    const cachePath = join(common, 'pullboard/main-red.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.entries[main]['test/inherited.test.js'].result, 'red');
    assert.equal((readFileSync(cachePath).length > 0), true);
    assert.equal(statSync(cachePath).mode & 0o077, 0, 'the result cache is private to this machine account');
    const firstCount = readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length;
    assert.equal(firstCount, before + 2, 'one selected candidate run and one exact-main run occurred');

    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// second candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): retry inherited red [G1]');
    red = submitter.run('submit', String(submitItem), '--infra', 'append a second candidate-only test marker to check exact-main cache reuse');
    inheritedMessage(red, { row: 'G1', item: rework });
    const secondCount = readFileSync(box.env.MAIN_RED_RUNS, 'utf8').trim().split('\n').length;
    assert.equal(secondCount, firstCount + 1, 'the second submit reuses the current-main file result');

    const afterEvidence = builder(box);
    const offered = afterEvidence.run('next', '--json');
    assert.equal(offered.code, 0, offered.err);
    assert.equal(JSON.parse(offered.out).item.item_id, rework, 'the unique main-red rework leads an earlier-milestone item within the same tier');
    const middleHolder = builder(box);
    assert.equal(middleHolder.run('claim', String(middle)).code, 0, 'a different builder can claim the non-priority same-tier item');
    assert.equal(afterEvidence.run('release', String(rework)).code, 0, 'release the selected rework before asking for another claim');
    const sole = afterEvidence.run('next', '--json');
    assert.equal(sole.code, 0, sole.err);
    assert.equal(JSON.parse(sole.out).item.item_id, rework, 'the only eligible same-tier item is never removed by prioritization');
    assert.equal(afterEvidence.run('release', String(rework)).code, 0);
    assert.equal(middleHolder.run('release', String(middle)).code, 0);
    put(box.root, 'README.md', 'A new main commit has no cached comparison yet.\n');
    const newMain = commit(box.root, box.env, 'chore: advance main fixture');
    assert.notEqual(newMain, main);
    const afterMainChange = builder(box).run('next', '--json');
    assert.equal(afterMainChange.code, 0, afterMainChange.err);
    assert.equal(JSON.parse(afterMainChange.out).item.item_id, middle, 'a cache for the former main cannot reorder the current main');
  });

  await t.test('multiple approved rows never produce a guessed row or item [V1]', (sub) => {
    const spec = [
      '# Ambiguous gate fixture\n\n## G · Goals',
      '- G1 [approved, must] First gate row. | gate: test/inherited.test.js',
      '- G2 [approved, must] Second gate row. | gate: test/inherited.test.js',
      '- G3 [approved, must] Submit row. | gate: test/unrelated.test.js',
      '- G4 [approved, must] Earlier work row. | gate: test/earlier.test.js',
    ].join('\n') + '\n';
    const box = fixture(sub, { spec, source: FAILING_TEST });
    const [first, second, earlier, submitItem] = addItems(box, [
      { title: 'First possible repair', specId: 'G1' },
      { title: 'Second possible repair', specId: 'G2' },
      { title: 'Earlier milestone work', specId: 'G4' },
      { title: 'Unrelated submit', specId: 'G3' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select ambiguous inherited red [G3]');
    const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to check ambiguous inherited row ownership');
    inheritedMessage(red);
    assert.doesNotMatch(red.err, new RegExp(`#${first}|#${second}`, 'u'));
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--items', `${first},${second}`).code, 0);
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, earlier, 'ambiguous rows leave next in its original milestone order');
  });

  await t.test('a row with several open owners does not prioritize either owner [V1]', (sub) => {
    const spec = [
      '# Multiple owner fixture\n\n## G · Goals',
      '- G1 [approved, must] Inherited gate row. | gate: test/inherited.test.js',
      '- G2 [approved, must] Submit row. | gate: test/unrelated.test.js',
      '- G3 [approved, must] Earlier work row. | gate: test/earlier.test.js',
    ].join('\n') + '\n';
    const box = fixture(sub, { spec, source: FAILING_TEST });
    const [first, second, earlier, submitItem] = addItems(box, [
      { title: 'First possible repair', specId: 'G1' },
      { title: 'Second possible repair', specId: 'G1' },
      { title: 'Earlier milestone work', specId: 'G3' },
      { title: 'Unrelated submit', specId: 'G2' },
    ]);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Early', '--items', String(earlier)).code, 0);
    assert.equal(cli(box.root, box.env, 'milestone', 'add', 'Later', '--items', `${first},${second}`).code, 0);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select multiply-owned inherited red [G2]');
    const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to check multiple inherited rework owners');
    inheritedMessage(red);
    assert.doesNotMatch(red.err, new RegExp(`#${first}|#${second}`, 'u'));
    const next = builder(box).run('next', '--json');
    assert.equal(next.code, 0, next.err);
    assert.equal(JSON.parse(next.out).item.item_id, earlier, 'several open owners leave next in its original milestone order');
  });

  await t.test('a candidate-only red keeps the old refusal text [V1]', (sub) => {
    const green = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
    const box = fixture(sub, { spec: RED_SPEC, source: green });
    const [, submitItem] = addItems(box, [
      { title: 'Repair unrelated gate row', specId: 'G1' },
      { title: 'Candidate-only submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
    commit(submitter.root, box.env, 'test(core): introduce candidate-only red [G2]');
    const red = submitter.run('submit', String(submitItem), '--infra', 'introduce a candidate-only failing assertion to distinguish it from inherited failure');
    assert.equal(red.code, 1, red.out || red.err);
    assert.match(red.err, /\[GATE_RED\]/u);
    assert.doesNotMatch(red.err, /also red on main|inherited main red|main not checked/u);
  });

  await t.test('without a focused runner the old refusal names the missing config key [V1]', (sub) => {
    const box = fixture(sub, { spec: RED_SPEC, source: FAILING_TEST, affectedTests: '' });
    const [, submitItem] = addItems(box, [
      { title: 'Repair inherited gate', specId: 'G1' },
      { title: 'Unrelated submit', specId: 'G2' },
    ]);
    const submitter = builder(box);
    assert.equal(submitter.run('claim', String(submitItem)).code, 0);
    put(submitter.root, 'test/inherited.test.js', `${FAILING_TEST}// candidate-only comment\n`);
    commit(submitter.root, box.env, 'test(core): select red without focused runner [G2]');
    const before = runCount(box);
    const red = submitter.run('submit', String(submitItem), '--infra', 'append a candidate-only test marker to exercise missing focused-runner guidance');
    assert.equal(red.code, 1, red.out || red.err);
    assert.match(red.err, /\[GATE_RED\]/u);
    assert.match(red.err, /main not checked: no focused test runner configured \(affectedTests\)/u);
    assert.equal(runCount(box), before + 1, 'the main comparison does not run a second full gate');
  });
});
