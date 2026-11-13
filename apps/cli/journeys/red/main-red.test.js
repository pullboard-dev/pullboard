/** A red item check remains mandatory and compares its failed files with main for recovery guidance [V1,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../../../packages/landing/src/io/main/red.js'; // The private driver below invokes this production entry point.
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { FAILING_TEST } from '../../tests/fixtures/red/main-red.js';
import { RED_SPEC } from '../../tests/fixtures/red/main-red.js';
import { addItems } from '../../tests/fixtures/red/main-red.js';
import { builder } from '../../tests/fixtures/red/main-red.js';
import { cli } from '../../tests/fixtures/red/main-red.js';
import { commit } from '../../tests/fixtures/red/main-red.js';
import { fixture } from '../../tests/fixtures/red/main-red.js';
import { inheritedMessage } from '../../tests/fixtures/red/main-red.js';
import { put } from '../../tests/fixtures/red/main-red.js';
import { runCount } from '../../tests/fixtures/red/main-red.js';

test('executor-pinned main comparisons run afresh, preserve generic cache and refuse another runtime [V4,C7]', t => {
  const box = fixture(t, {
    spec: '# Fixture\n\n## G · Goals\n- G1 [approved, must] The inherited case passes. | gate: test/inherited.test.js\n',
    source: "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('inherited red [G1]', () => assert.equal(1, 2));\n",
  });
  put(box.root, 'test/new-red.test.js', "import { test } from 'node:test'; test('new failure [G1]', () => {});\n");
  commit(box.root, box.env);
  const driver = join(box.directory, 'pinned-comparison.mjs');
  writeFileSync(driver, [
    `import { compareMainFailures } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/src/io/main/red.js')).href)};`,
    `import { matchingMainFailures } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/src/io/main/matches.js')).href)};`,
    `import { executionEnvironment } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/sandbox/src/io/environment.js')).href)};`,
    `import { readGateReceipt, receiptStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href)};`,
    'const [root, mode] = process.argv.slice(2);',
    "const profile = {tests:[{file:'test/inherited.test.js',passed:false}, ...(mode === 'recorded-mixed' ? [{file:'test/new-red.test.js',passed:false}] : [])]};",
    'const environment = executionEnvironment();',
    "const execution = mode === 'generic' ? undefined : { executor: {kind:'local'}, environment: mode === 'unknown' ? null : mode === 'mismatch' ? {...environment,node:'99.0.0'} : environment };",
    "let recordedRuns = []; if (mode.startsWith('recorded')) { const ids=[]; await compareMainFailures(root, profile, undefined, '', {execution, detailed:true, onMeasuredReceipt: value => { ids.push(value); }}); if (!ids.length) throw Error('native receipt missing'); recordedRuns = ids.map(id => readGateReceipt(receiptStore(root), id)); if (mode === 'recorded-altered') recordedRuns[0] = {...recordedRuns[0], green:true}; }",
    'const result = await compareMainFailures(root, profile, undefined, "", {execution, detailed: mode.startsWith("recorded"), recordedRuns});',
    "if (mode === 'recorded-mixed') { const old = result.files[0].failures[0]; const added = {file:'test/new-red.test.js',name:'new failure [G1]',signature:'0'.repeat(64)}; result.oldMatches = !!matchingMainFailures([old],result,result.main); result.bothMatch = !!matchingMainFailures([old,added],result,result.main); }",
    'console.log(JSON.stringify(result));',
  ].join('\n'));
  const run = mode => {
    const result = runFixtureChild(process.execPath, [driver, box.root, mode],
      { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const cached = run('generic');
  assert.equal(cached.files[0].result, 'red');
  const common = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: box.root, env: box.env }).trim();
  const cachePath = join(common, 'pullboard/main-red.json');
  // Pinned runs share only content records keyed by their executor and runtime; the generic commit entry is never theirs (#3166).
  const genericAt = () => JSON.stringify(JSON.parse(readFileSync(cachePath, 'utf8')).entries[cached.main]);
  const cacheBefore = genericAt();
  const callsBefore = runCount(box);
  assert.equal(run('matching').files[0].result, 'red');
  assert.ok(runCount(box) > callsBefore, 'a pinned comparison executes rather than reusing generic evidence');
  assert.equal(genericAt(), cacheBefore, 'pinned evidence does not alter the generic commit entry');
  const beforeRecorded = runCount(box);
  assert.equal(run('recorded').files[0].result, 'red');
  assert.equal(runCount(box), beforeRecorded + 1, 'a retained native comparison is reused without another main run');
  const beforeAltered = runCount(box);
  assert.equal(run('recorded-altered').files[0].result, 'red');
  // The altered receipt claims green; the red result shows it was refused, and the exact pinned content record served (#3166).
  assert.equal(runCount(box), beforeAltered, 'altered event evidence is never used; the pinned content record answers without a run');
  const beforeMixed = runCount(box);
  const mixed = run('recorded-mixed');
  assert.equal(mixed.oldMatches, true, 'the inherited case is accounted for');
  assert.equal(mixed.bothMatch, false, 'a new head failure remains blocking');
  assert.equal(runCount(box), beforeMixed + 1, 'only the file never measured on this runtime runs; both are then reused without another run');
  const mismatch = run('mismatch');
  assert.deepEqual(mismatch.files, []);
  assert.match(mismatch.unavailable, /exact runtime/u);
  assert.equal(genericAt(), cacheBefore, 'a runtime mismatch cannot publish generic evidence');
  const beforeUnknown = runCount(box);
  const unknown = run('unknown');
  assert.deepEqual(unknown.files, []);
  assert.match(unknown.unavailable, /no complete executor and runtime identity/u);
  assert.equal(runCount(box), beforeUnknown, 'missing execution facts refuse before any comparison run');
});

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
    '// pullboard: browser',
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { test } from 'node:test';",
    '/** The first-line declaration makes this a browser admission fixture, without launching Chrome here. */',
    "export function browserLaunch() { return spawnSync('google-chrome', []); }",
    "test('browser-capable comparison stays red [V1]', () => assert.equal(1, 2));",
  ].join('\n') + '\n');
  const main = commit(box.root, box.env);
  const control = join(box.directory, 'cpu-browser-control');
  mkdirSync(control);
  const queue = join(box.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite');
  const driver = join(box.directory, 'cpu-browser-driver.mjs');
  writeFileSync(driver, [
    `import { withGateSlot } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href)};
${executionServicesSource(pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href)}`,
    `import { compareMainFailures } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/landing/src/io/main/red.js')).href)};`,
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const [mode, root, control] = process.argv.slice(2);',
    "if (mode === 'holder') {",
    '  await withGateSlot(root, async lease => {',
    "    if (!lease.browser) throw new Error('the fixture requires a real browser lease');",
    "    writeFileSync(join(control,'browser.ready'),'ready');",
    "    while (!existsSync(join(control,'browser.release'))) await new Promise(done => setTimeout(done,10));",
    "  }, {executionServices,browser:true,remote:false,agent:'fixture-browser-holder'});",
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
  const red = submitter.run('submit', String(submitItem));
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
    "if (process.env.MAIN_RED_STAGE !== 'check') appendFileSync(process.env.MAIN_RED_RUNS, `${process.cwd()}\\n`);",
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

