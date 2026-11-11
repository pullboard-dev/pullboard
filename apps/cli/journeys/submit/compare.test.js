/** Red submit diagnostics release the seat and share the machine pool [V4,C7,Q4,B7]. */
// The subprocess invokes this entry point; retain its import edges for future affected-test selection.
import '../../index.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  join,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { GATE_SLOT_HELD_ENV } from '../../../../packages/resources/index.js';
import { readGateReceipt } from '../../../../packages/gate/index.js';
import {
  runFixtureChild,
  runFixtureGit,
  startFixtureChild,
} from '../../tests/fixtures/child.js';

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** Quote the current native CLI path for hooks in this fixture's private executable shim. */
function shellWord(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Write a committed fixture input while keeping all control files outside the checkout. */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Run the real CLI with a private machine home and explicit session identity. */
function cli(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd: root, env: box.env, encoding: 'utf8' });
}

/** Commit the exact fixture inputs using its isolated author identity. */
function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'test(core): comparison fixture [G1]'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env });
}

/** Capture asynchronous CLI completion without a throughput deadline or synthetic CLI replacement. */
function launch(box, ...args) {
  const wait = args[0] === 'submit' ? ['--wait'] : [];
  const child = startFixtureChild(process.execPath, [BIN, ...args, ...wait, '--json'], {
    cwd: box.builder, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', part => { out += part; });
  child.stderr.setEncoding('utf8').on('data', part => { err += part; });
  Object.defineProperties(child, { capturedStdout: { get: () => out }, capturedStderr: { get: () => err } });
  child.closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal, out, err })));
  box.children.push(child);
  return child;
}

/** Wait for an actual handshake, using a hang ceiling rather than judging how fast work runs. */
async function observed(predicate, label) {
  const deadline = Date.now() + 20_000; // budget: hang ceiling for fixture file and queue handshakes, not a throughput expectation.
  while (!predicate() && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.ok(predicate(), label);
}

/** Preserve the hang ceiling while reporting a submit that exits before its comparison runner starts. */
async function comparisonStarted(box, submission, label) {
  await observed(() => events(box).some(event => event.phase === 'start') || submission.exitCode !== null, label);
  const started = events(box).some(event => event.phase === 'start');
  const phases = rows(box.board, 'SELECT event_kind,event_detail FROM event WHERE item_id=? ORDER BY event_id', [box.item])
    .map(event => ({ kind: event.event_kind, detail: JSON.parse(event.event_detail) }));
  assert.ok(started, `${label}; submit exit=${submission.exitCode}; stdout=${submission.capturedStdout}; stderr=${submission.capturedStderr}; phases=${JSON.stringify(phases)}; runnerEvents=${JSON.stringify(events(box))}`);
}

/** Read authentic main-red receipts retained by the native gate, bound to the fixture's exact main commit. */
function mainReceipts(box) {
  const folder = join(box.root, '.git', 'pullboard', 'gate-receipts');
  return readdirSync(folder).filter(name => name.endsWith('.json'))
    .map(name => readGateReceipt(folder, name.slice(0, -5)))
    .filter(receipt => receipt?.kind === 'main-red' && receipt.head === box.main && receipt.main === box.main)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/** Read a private queue or board, allowing the same short SQLite writer contention as the resource API. */
function rows(file, sql, parameters = []) {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=10000; PRAGMA query_only=ON'); return db.prepare(sql).all(...parameters); }
  finally { db.close(); }
}

/** Read complete append-only comparison observations. */
function events(box) {
  if (!existsSync(box.events)) return [];
  return readFileSync(join(box.directory, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Release every comparison before waiting for children and removing this fixture. */
async function cleanup(box) {
  for (const name of box.names) writeFileSync(join(box.control, name + '.release'), 'release');
  await Promise.all(box.children.map(child => child.closed));
  rmSync(box.directory, { recursive: true, force: true });
}

/** Build a real joined board whose native red tests pause only in exact-main comparison clones. */
function fixture(t, count, slots = 2) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-compare-')));
  const root = join(directory, 'repo');
  const control = join(directory, 'control');
  mkdirSync(root);
  mkdirSync(control);
  put(directory, 'bin/pullboard', `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(directory, 'bin/pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || AGENT_SHELL_MARKERS.includes(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env[GATE_SLOT_HELD_ENV];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Comparison fixture', GIT_AUTHOR_EMAIL: 'compare@example.invalid',
    GIT_COMMITTER_NAME: 'Comparison fixture', GIT_COMMITTER_EMAIL: 'compare@example.invalid',
    PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    PATH: [join(directory, 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
    CODEX_SESSION_ID: 'comparison-fixture-session', PULLBOARD_MODEL: 'Fixture Model',
    COMPARE_CONTROL: control, COMPARE_EVENTS: join(directory, 'events.jsonl'),
  });
  const names = ['a', 'b', 'c'].slice(0, count);
  const box = { directory, root, control, names, env, events: env.COMPARE_EVENTS, children: [] };
  t.after(() => cleanup(box));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  assert.equal(cli(box, root, 'init').status, 0);
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js', affectedTests: 'node test/runner.js',
    lanes: { core: { owns: ['test/'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Comparison fixture\n\n## G · Goals\n- G1 [approved, must] The comparison retains a red verdict. | gate: test\n');
  for (const name of names) put(root, `test/${name}.test.js`,
    `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('${name} native comparison [G1]', () => assert.equal(1, ${name === 'b' ? 2 : 1}));\n`);
  put(root, 'test/runner.js', [
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { basename, join } from 'node:path';",
    `const files = process.argv.slice(2).length ? process.argv.slice(2) : ${JSON.stringify(names.map(name => `test/${name}.test.js`))};`,
    "const comparison = basename(process.cwd()) === 'checkout';",
    "const name = basename(files[0], '.test.js');",
    "/** Record each real start or finish, including its inherited pool marker. */",
    "function record(phase) { appendFileSync(process.env.COMPARE_EVENTS, JSON.stringify({phase, name, cwd: process.cwd(), slot: process.env.PULLBOARD_GATE_SLOT_HELD}) + '\\n'); }",
    "if (comparison) {",
    "  record('start');",
    "  writeFileSync(join(process.env.COMPARE_CONTROL, name + '.started'), 'started');",
    "  while (!existsSync(join(process.env.COMPARE_CONTROL, name + '.release'))) await new Promise(done => setTimeout(done, 10));",
    "}",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    "if (comparison) record('finish');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  box.main = commit(box, root);
  assert.equal(cli(box, root, 'settings', 'gateSlots', String(slots)).status, 0);
  const added = cli(box, root, 'add', 'core', 'Retain the native red verdict', '--specs', 'G1', '--route', 'mid',
    '--criterion', 'A red test is refused', '--check', 'true', '--brief', 'Files: test/\nTest: native comparison');
  assert.equal(added.status, 0, added.stderr);
  box.item = JSON.parse(added.stdout).item.item_id;
  const made = cli(box, root, 'worktree', 'core', '--model', 'Fixture Model');
  assert.equal(made.status, 0, made.stderr);
  box.builder = JSON.parse(made.stdout).path;
  assert.equal(cli(box, box.builder, 'claim', String(box.item)).status, 0);
  for (const name of names) put(box.builder, `test/${name}.test.js`,
    `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('${name} native comparison [G1]', () => assert.equal(1, 2));\n// Candidate-only input.\n`);
  box.head = commit(box, box.builder);
  box.cache = join(root, '.git/pullboard/main-red.json');
  box.board = join(root, '.git/pullboard/board.sqlite');
  box.repoQueue = join(root, '.git/pullboard/resources.sqlite');
  box.machineQueue = join(env.PULLBOARD_MACHINE_HOME, 'resources.sqlite');
  return box;
}

/** A comparison must preserve the refusal and both Git heads after all diagnostics finish. */
async function assertRed(box, submission) {
  const result = await submission.closed;
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'GATE_RED');
  assert.equal(rows(box.board, 'SELECT item_status FROM item')[0].item_status, 'claimed');
  assert.equal(runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.builder, env: box.env }), box.head);
  assert.equal(runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env }), box.main);
  for (const event of events(box)) assert.equal(existsSync(event.cwd), false, 'temporary main checkouts are removed');
}

test('a shout completes while a submit compares with main [V4,C7,B7]', async t => {
  const box = fixture(t, 1);
  const submission = launch(box, 'submit', String(box.item));
  await comparisonStarted(box, submission, 'the real main comparison is waiting');
  const shout = launch(box, 'shout', 'all', 'Comparison is still running');
  await observed(() => shout.exitCode !== null || (rows(box.repoQueue,
    "SELECT token FROM holder WHERE name LIKE 'checkout-session:%' AND pid=?", [submission.pid]).length > 0
    && rows(box.repoQueue, "SELECT ticket FROM waiter WHERE name LIKE 'checkout-session:%'").length > 0),
  'the shout completes or waits behind the submitting process');
  assert.equal(shout.exitCode, 0, 'the same-seat shout completes before releasing the comparison');
  assert.equal((await shout.closed).code, 0);
  assert.equal(rows(box.board, "SELECT shout_text FROM shout WHERE shout_text='Comparison is still running'").length, 1);
  const fact = cli(box, box.builder, 'fact', String(box.item), 'note', 'This fact lands during the comparison');
  assert.equal(fact.status, 0, fact.stderr);
  assert.equal(cli(box, box.builder, 'show', String(box.item)).status, 0, 'same-seat reads remain available');
  assert.equal(submission.exitCode, null, 'diagnostics remain held until the explicit release');
  assert.equal(events(box).filter(event => event.phase === 'finish').length, 0);
  writeFileSync(join(box.control, 'a.release'), 'release');
  await assertRed(box, submission);
});

test('a red submit reruns its failed files one slot at a time within the pool [V4,C7,Q4]', async t => {
  const box = fixture(t, 3, 2);
  const submission = launch(box, 'submit', String(box.item));
  await comparisonStarted(box, submission, 'the first exact-main comparison starts');
  assert.equal(rows(box.machineQueue, "SELECT token FROM holder WHERE name='gate'").length, 1,
    'the running comparison holds one actual pool slot');
  assert.equal(rows(box.machineQueue, "SELECT ticket FROM waiter WHERE name='gate'").length, 0,
    'the remaining files do not flood the machine queue');
  const first = events(box).find(event => event.phase === 'start').name;
  writeFileSync(join(box.control, first + '.release'), 'release');
  await observed(() => events(box).filter(event => event.phase === 'start').length === 2,
    'the second file starts after the first finishes');
  const firstReceipt = mainReceipts(box).find(receipt => receipt.command);
  assert.ok(firstReceipt, 'the completed native receipt is retained while other files still wait');
  assert.equal(firstReceipt.green, first !== 'b', 'the receipt preserves the exact main-file verdict');
  assert.deepEqual(firstReceipt.failures.map(row => row.name), first === 'b' ? ['b native comparison [G1]'] : [],
    'the native receipt retains the exact red case identity');
  for (const name of box.names) writeFileSync(join(box.control, name + '.release'), 'release');
  await assertRed(box, submission);
  let active = 0;
  let maximum = 0;
  for (const event of events(box)) {
    assert.equal(event.slot, '1', 'each runner inherits a real parent-held slot');
    active += event.phase === 'start' ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  assert.equal(maximum, 1, 'one submit leaves the other machine slot available');
  assert.equal(active, 0);
  const receipts = mainReceipts(box);
  assert.equal(receipts.length, 3, 'each exact-main file has one retained native comparison receipt');
  const byFile = Object.fromEntries(receipts.map(receipt => {
    const file = box.names.map(name => `test/${name}.test.js`).find(path => receipt.command === createHash('sha256')
      .update(`PULLBOARD_TEST_REUSE=record node test/runner.js './${path}'`).digest('hex'));
    assert.ok(file, `native receipt command identifies one exact main file: ${receipt.command}`);
    return [file, receipt];
  }));
  assert.deepEqual(Object.fromEntries(Object.entries(byFile).map(([file, receipt]) => [file, receipt.green])), {
    'test/a.test.js': true, 'test/b.test.js': false, 'test/c.test.js': true,
  });
  assert.deepEqual(byFile['test/a.test.js'].failures, []);
  assert.deepEqual(byFile['test/c.test.js'].failures, []);
  assert.deepEqual(byFile['test/b.test.js'].failures, [{ file: 'test/b.test.js', name: 'b native comparison [G1]' }]);
  assert.equal(byFile['test/b.test.js'].failureSignatures.failures.length, 1);
  assert.match(byFile['test/b.test.js'].failureSignatures.failures[0].signature, /^[a-f0-9]{64}$/u);
  assert.equal(rows(box.machineQueue, 'SELECT token FROM holder').length, 0, 'all machine leases are released');
  const before = events(box).length;
  const receiptCount = mainReceipts(box).length;
  await assertRed(box, launch(box, 'submit', String(box.item)));
  assert.equal(events(box).length, before, 'the identical red resubmit does not rerun the completed main comparisons');
  assert.equal(mainReceipts(box).length, receiptCount, 'the identical red resubmit reuses completed exact-main results');
});
